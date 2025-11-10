// WebGL Particle Simulation - Memory Optimized for 1M Particles
class ParticleSystem {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2');
        
        if (!this.gl) {
            alert('WebGL 2.0 not supported');
            return;
        }

        this.spawnRatePerSecond = 1000; // Particles per second (user controllable)
        this.lastSpawnTime = performance.now();
        this.spawnTimeAccumulator = 0; // Accumulator for consistent spawn timing
        this.particlesToSpawn = 0; // Accumulated particles to spawn
        this.isPaused = false; // Animation pause state
        this.animationFrameId = null; // Track animation frame
        this.roundRobinIndex = 0; // Persistent index for round-robin particle distribution across frames
        this.spawnMode = 'fountain'; // Particle spawn mode: 'fountain', 'wind', or 'rain'
        
        this.colorCounts = {}; // Object mapping color strings to target counts
        this.cachedColorCounts = {}; // Cached actual particle counts per color (updated incrementally)
        this.availableColors = []; // Store color definitions
        
        // Memory-optimized particle storage: Reduced from 17 to 12 bytes per particle
        // Each particle: [x, y] = 2 floats (8 bytes) + [vx, vy] = 2 Int16 (4 bytes) + colorIndex (1 byte) = 13 bytes
        // Actually: Using packed format - positions as Float32, velocities as Int16 scaled
        this.particleData = null; // Float32Array for positions (x, y) - 2 floats per particle
        this.velocityData = null; // Int16Array for velocities (vx, vy) - 2 int16s per particle (scaled by 1000)
        this.colorIndexData = null; // Uint8Array for color indices - 1 byte per particle
        this.particleCount = 0;
        this.maxParticles = 1000000; // Support up to 1M particles
        this.particleCapacity = 0;
        
        // Velocity scaling factor (Int16 range: -32768 to 32767)
        // Scale velocities by 1000: actual velocity = velocityInt16 / 1000
        this.velocityScale = 1000.0;
        this.velocityScaleInv = 1.0 / 1000.0; // Pre-compute inverse for faster division
        
        // Performance tracking
        this.frameCount = 0;
        this.lastFpsUpdate = performance.now();
        this.fps = 0;
        
        // Real-time particle speed tracking (for lag detection)
        this.referenceParticleIndex = 0; // Track a reference particle
        this.lastRealTimeCheck = performance.now();
        this.referenceParticleLastX = 0;
        this.referenceParticleLastY = 0;
        this.referenceParticleVelocity = 0; // Store velocity magnitude
        this.simulationSpeed = 1.0; // 1.0 = normal speed, <1.0 = lagging
        this.frameCountForSpeedTracking = 0; // Track frames between real-time checks
        
        this.init();
    }

    init() {
        this.resize();
        window.addEventListener('resize', () => this.resize());
        
        this.createShaders();
        this.createBuffers();
        this.setupColorPalette();
        this.createParticles();
        this.setupSlider();
        this.setupControls();
        
        this.animate();
    }

    setupSlider() {
        // Spawn rate toggle button - cycles through 1K, 10K, 100K
        const spawnRateToggle = document.getElementById('spawnRateToggle');
        
        // Define spawn rates in order (cycling order)
        this.spawnRates = [
            { value: 1000, label: '1K' },
            { value: 10000, label: '10K' },
            { value: 100000, label: '100K' }
        ];
        
        // Track current rate index
        this.currentSpawnRateIndex = 0;

        if (spawnRateToggle) {
            // Update button text and spawn rate based on current index
            this.updateSpawnRateButton();
            
            spawnRateToggle.addEventListener('click', () => {
                // Cycle to next rate
                this.currentSpawnRateIndex = (this.currentSpawnRateIndex + 1) % this.spawnRates.length;
                
                // Update spawn rate
                const newRate = this.spawnRates[this.currentSpawnRateIndex];
                this.spawnRatePerSecond = newRate.value;
                
                // Update button text
                this.updateSpawnRateButton();
                
                // Reset accumulator and round-robin index when spawn rate changes for consistent timing
                this.spawnTimeAccumulator = 0;
                this.roundRobinIndex = 0;
            });
        }
    }
    
    updateSpawnRateButton() {
        const spawnRateToggle = document.getElementById('spawnRateToggle');
        if (spawnRateToggle && this.spawnRates) {
            const currentRate = this.spawnRates[this.currentSpawnRateIndex];
            spawnRateToggle.textContent = currentRate.label;
        }
    }
    
    colorToKey(color) {
        return `${color[0]},${color[1]},${color[2]}`;
    }
    
    getParticleCountForColor(color) {
        // Use cached count for O(1) lookup instead of scanning all particles
        const colorKey = this.colorToKey(color);
        return this.cachedColorCounts[colorKey] || 0;
    }
    
    getColorIndex(color) {
        // Find color index in availableColors array
        for (let i = 0; i < this.availableColors.length; i++) {
            const c = this.availableColors[i].rgb;
            if (c[0] === color[0] && c[1] === color[1] && c[2] === color[2]) {
                return i;
            }
        }
        return 0; // Default to first color
    }
    
    ensureParticleCapacity(count) {
        if (count > this.particleCapacity) {
            // Grow capacity by 1.5x or to target count, whichever is larger
            const newCapacity = Math.max(
                Math.ceil(this.particleCapacity * 1.5),
                count
            );
            
            // Optimized: positions (2 floats) + velocities (2 int16s) + color (1 byte)
            const newParticleData = new Float32Array(newCapacity * 2); // x, y only
            const newVelocityData = new Int16Array(newCapacity * 2); // vx, vy scaled
            const newColorIndexData = new Uint8Array(newCapacity);
            
            // Copy existing data
            if (this.particleData) {
                newParticleData.set(this.particleData.subarray(0, this.particleCount * 2));
            }
            if (this.velocityData) {
                newVelocityData.set(this.velocityData.subarray(0, this.particleCount * 2));
            }
            if (this.colorIndexData) {
                newColorIndexData.set(this.colorIndexData.subarray(0, this.particleCount));
            }
            
            this.particleData = newParticleData;
            this.velocityData = newVelocityData;
            this.colorIndexData = newColorIndexData;
            this.particleCapacity = newCapacity;
        }
    }
    
    /**
     * Calculate accurate memory usage for particles
     * Returns an object with detailed memory breakdown
     * 
     * Memory breakdown (OPTIMIZED):
     * - Particle Storage: TypedArrays storing particle data
     *   - Float32Array: capacity * 2 floats * 4 bytes = 8 bytes per particle capacity (positions)
     *   - Int16Array: capacity * 2 int16s * 2 bytes = 4 bytes per particle capacity (velocities)
     *   - Uint8Array: capacity * 1 byte per particle capacity (color indices)
     *   - Total: 13 bytes per particle (reduced from 17 bytes)
     * - Rendering Buffers: Temporary buffers used each frame for WebGL
     *   - Position buffer: particleCount * 2 floats * 4 bytes
     *   - Color index buffer: particleCount * 1 float * 4 bytes (replaces old color buffer)
     *   - Size: Uniform (constant, no per-particle storage)
     *   - Color palette: Uniform array (10 colors, ~120 bytes total, not per-particle)
     * - WebGL Buffer Overhead: Metadata for GPU buffers (~64 bytes per buffer)
     */
    calculateMemoryUsage() {
        const result = {
            particleStorage: {
                allocated: 0,
                used: 0,
                overhead: 0
            },
            renderingBuffers: {
                allocated: 0,
                used: 0
            },
            total: {
                allocated: 0,
                used: 0,
                bytesPerParticle: 0
            }
        };
        
        // Particle storage memory (Optimized TypedArrays)
        if (this.particleData && this.velocityData && this.colorIndexData) {
            // Allocated capacity
            // Float32Array: capacity * 2 floats * 4 bytes = capacity * 8 bytes (positions)
            // Int16Array: capacity * 2 int16s * 2 bytes = capacity * 4 bytes (velocities)
            // Uint8Array: capacity * 1 byte (color indices)
            const particleDataBytes = this.particleCapacity * 2 * 4; // Float32Array for positions
            const velocityDataBytes = this.particleCapacity * 2 * 2; // Int16Array for velocities
            const colorIndexBytes = this.particleCapacity * 1; // Uint8Array
            
            result.particleStorage.allocated = particleDataBytes + velocityDataBytes + colorIndexBytes;
            
            // Actually used memory
            const usedParticleDataBytes = this.particleCount * 2 * 4; // Float32Array
            const usedVelocityDataBytes = this.particleCount * 2 * 2; // Int16Array
            const usedColorIndexBytes = this.particleCount * 1; // Uint8Array
            
            result.particleStorage.used = usedParticleDataBytes + usedVelocityDataBytes + usedColorIndexBytes;
            result.particleStorage.overhead = result.particleStorage.allocated - result.particleStorage.used;
        }
        
        // Rendering buffer memory (temporary buffers used each frame)
        if (this.positionBufferData && this.colorIndexBufferData) {
            const currentCount = this.particleCount;
            
            // Position buffer: currentCount * 2 floats * 4 bytes
            const positionBufferBytes = this.positionBufferData.length * 4;
            
            // Color index buffer: currentCount * 1 float * 4 bytes (replaces color buffer)
            const colorIndexBufferBytes = this.colorIndexBufferData.length * 4;
            
            // Size is now a uniform (no buffer needed)
            // Color palette is now a uniform (no buffer needed)
            
            result.renderingBuffers.allocated = positionBufferBytes + colorIndexBufferBytes;
            result.renderingBuffers.used = result.renderingBuffers.allocated; // These are always fully used
        }
        
        // WebGL buffer overhead (estimated - GPU-side buffers also have some CPU overhead)
        // This is minimal but exists for buffer metadata
        const webglBufferOverhead = 2 * 64; // ~64 bytes per WebGL buffer handle/metadata (2 buffers: position + colorIndex)
        
        // Total memory
        result.total.allocated = result.particleStorage.allocated + result.renderingBuffers.allocated + webglBufferOverhead;
        result.total.used = result.particleStorage.used + result.renderingBuffers.allocated + webglBufferOverhead;
        
        // Calculate bytes per particle (only for used particles)
        if (this.particleCount > 0) {
            result.total.bytesPerParticle = result.total.used / this.particleCount;
        } else {
            result.total.bytesPerParticle = 0;
        }
        
        return result;
    }

    setupColorPalette() {
        const colorSliderList = document.getElementById('colorSliderList');

        // Define available colors (RGB values 0-1)
        this.availableColors = [
            { name: 'Blue', rgb: [0.4, 0.7, 1.0] },
            { name: 'Purple', rgb: [0.6, 0.4, 0.9] },
            { name: 'Pink', rgb: [0.9, 0.4, 0.6] },
            { name: 'Yellow', rgb: [1.0, 0.9, 0.3] },
            { name: 'Red', rgb: [1.0, 0.3, 0.3] },
            { name: 'White', rgb: [0.9, 0.9, 0.9] }
        ];

        // Initialize color counts
        this.availableColors.forEach(colorData => {
            const colorKey = this.colorToKey(colorData.rgb);
            this.colorCounts[colorKey] = 0;
            this.cachedColorCounts[colorKey] = 0; // Initialize cached counts
        });

        // Pre-compute color arrays as Float32Arrays for faster render loop access
        this.precomputedColors = [];
        this.availableColors.forEach(colorData => {
            this.precomputedColors.push(new Float32Array(colorData.rgb));
        });

        // Pre-compute color palette array for uniform upload (flattened: [r,g,b, r,g,b, ...])
        this.colorPaletteArray = new Float32Array(this.availableColors.length * 3);
        for (let i = 0; i < this.availableColors.length; i++) {
            const rgb = this.availableColors[i].rgb;
            const idx = i * 3;
            this.colorPaletteArray[idx] = rgb[0];
            this.colorPaletteArray[idx + 1] = rgb[1];
            this.colorPaletteArray[idx + 2] = rgb[2];
        }

        // Create individual sliders for each color
        this.colorToSliderIndex = {}; // Map color keys to slider indices
        this.availableColors.forEach((colorData, index) => {
            const colorKey = this.colorToKey(colorData.rgb);
            this.colorToSliderIndex[colorKey] = index;
            const sliderItem = document.createElement('div');
            sliderItem.className = 'color-slider-item';

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.id = `colorSlider-${index}`;
            slider.min = '0';
            slider.max = '500000';
            slider.value = '0';
            slider.step = '1000';

            // Set the slider knob color to match the particle color
            const rgbColor = `rgb(${Math.round(colorData.rgb[0] * 255)}, ${Math.round(colorData.rgb[1] * 255)}, ${Math.round(colorData.rgb[2] * 255)})`;
            slider.style.setProperty('--thumb-color', rgbColor);

            // Current count display (left side)
            const currentCountDisplay = document.createElement('span');
            currentCountDisplay.className = 'current-count';
            currentCountDisplay.id = `colorCurrentCount-${index}`;
            currentCountDisplay.textContent = '0';

            // Target count display (right side)
            const targetCountDisplay = document.createElement('span');
            targetCountDisplay.className = 'target-count';
            targetCountDisplay.id = `colorTargetCount-${index}`;
            targetCountDisplay.textContent = '0';

            // MAX button to set slider to maximum value
            const maxButton = document.createElement('button');
            maxButton.className = 'max-button';
            maxButton.textContent = 'MAX';
            maxButton.type = 'button';
            maxButton.addEventListener('click', () => {
                const maxValue = parseInt(slider.max);
                slider.value = maxValue;
                // Trigger the input event to update everything
                slider.dispatchEvent(new Event('input'));
            });

            // Handle slider changes - set target count and delete particles if needed
            slider.addEventListener('input', (e) => {
                const targetCount = parseInt(e.target.value);
                const colorKey = this.colorToKey(colorData.rgb);
                const currentCount = this.cachedColorCounts[colorKey] || 0;

                // Set target count for this color
                this.colorCounts[colorKey] = targetCount;
                
                // Update target count display (right side)
                targetCountDisplay.textContent = targetCount.toLocaleString();
                
                // If target is less than current count, delete excess particles
                if (targetCount < currentCount) {
                    const particlesToDelete = currentCount - targetCount;
                    this.deleteParticles(colorData.rgb, particlesToDelete);
                }
            });

            // Append in order: current count, slider, target count, MAX button
            sliderItem.appendChild(currentCountDisplay);
            sliderItem.appendChild(slider);
            sliderItem.appendChild(targetCountDisplay);
            sliderItem.appendChild(maxButton);
            colorSliderList.appendChild(sliderItem);
        });
    }


    resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();

        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;

        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        this.width = this.canvas.width;
        this.height = this.canvas.height;

    }

    createShaders() {
        const vertexShaderSource = `#version 300 es
            in vec2 a_position;
            in float a_colorIndex;
            
            uniform vec2 u_resolution;
            uniform float u_time;
            uniform float u_size;
            uniform vec3 u_colorPalette[6]; // Fixed palette of 6 colors
            
            out vec3 v_color;
            
            void main() {
                vec2 position = a_position;
                position.y = u_resolution.y - position.y;
                
                vec2 clipSpace = ((position / u_resolution) * 2.0) - 1.0;
                
                gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
                gl_PointSize = u_size;
                
                // Look up color from palette using colorIndex
                int index = int(a_colorIndex);
                v_color = u_colorPalette[index];
            }
        `;

        const fragmentShaderSource = `#version 300 es
            precision highp float;
            
            in vec3 v_color;
            out vec4 fragColor;
            
            void main() {
                vec2 center = gl_PointCoord - vec2(0.5);
                float dist = length(center);
                
                if (dist > 0.5) {
                    discard;
                }
                
                float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
                fragColor = vec4(v_color, alpha * 0.8);
            }
        `;

        const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, vertexShaderSource);
        const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, fragmentShaderSource);
        
        this.program = this.createProgram(vertexShader, fragmentShader);
        
        this.gl.useProgram(this.program);
        
        // Get attribute locations
        this.positionLocation = this.gl.getAttribLocation(this.program, 'a_position');
        this.colorIndexLocation = this.gl.getAttribLocation(this.program, 'a_colorIndex');
        
        // Get uniform locations
        this.resolutionLocation = this.gl.getUniformLocation(this.program, 'u_resolution');
        this.timeLocation = this.gl.getUniformLocation(this.program, 'u_time');
        this.sizeLocation = this.gl.getUniformLocation(this.program, 'u_size');
        this.colorPaletteLocation = this.gl.getUniformLocation(this.program, 'u_colorPalette');
    }

    compileShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            this.gl.deleteShader(shader);
            return null;
        }
        
        return shader;
    }

    createProgram(vertexShader, fragmentShader) {
        const program = this.gl.createProgram();
        this.gl.attachShader(program, vertexShader);
        this.gl.attachShader(program, fragmentShader);
        this.gl.linkProgram(program);
        
        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            this.gl.deleteProgram(program);
            return null;
        }
        
        return program;
    }

    createBuffers() {
        // Position buffer
        this.positionBuffer = this.gl.createBuffer();
        
        // Color index buffer (replaces color buffer)
        this.colorIndexBuffer = this.gl.createBuffer();
        
        // Reusable buffer data arrays
        this.positionBufferData = null;
        this.colorIndexBufferData = null;
    }

    createParticles() {
        // Initialize particle data array (lazy allocation)
        // Capacity will grow as needed
        this.particleCount = 0;
        this.particleCapacity = 0;
    }

    createParticle(color, spawnMode = null) {
        // Ensure capacity is allocated before creating particle
        if (!this.particleData || !this.velocityData || !this.colorIndexData) {
            this.ensureParticleCapacity(this.particleCount + 1);
        }

        // Use provided spawn mode or default to current spawn mode
        const mode = spawnMode || this.spawnMode;

        // Small variation in direction for subtle flow
        let angleVariation = (Math.random() - 0.5) * 0.3;
        const speedVariation = 0.7 + Math.random() * 0.3;

        let x, y;
        let baseDirection, baseSpeed;

        if (mode === 'wind') {
            // Wind: spawn from left edge, move to the right
            x = 0; // Left edge
            y = Math.random() * this.height; // Random vertical position
            baseDirection = 0; // Rightward direction (0 radians = right)
            baseSpeed = 1.0 + Math.random() * 0.5; // Moderate speed
        } else if (mode === 'rain') {
            // Rain: spawn from top edge, fall straight down (faster than snow)
            // Coordinate system: JS y=0 → bottom on screen, JS y=height → top on screen
            // Direction: Math.PI/2 (positive Y) → upward, -Math.PI/2 (negative Y) → downward
            x = Math.random() * this.width; // Random horizontal position across top
            y = this.height; // Top edge (JS y=height becomes top on screen after shader flip)
            baseDirection = -Math.PI / 2; // Negative Y in JS becomes downward on screen
            baseSpeed = 2.0 + Math.random() * 2.0; // Fast fall speed for rain
            // Minimal horizontal variation for rain (more direct fall)
            angleVariation = (Math.random() - 0.5) * 0.1; // Small horizontal variation
        } else {
            // Fountain: spawn from bottom edge, arc upward (compensating for shader Y-flip)
            x = this.width / 2 + (Math.random() - 0.5) * 200; // Center with wider spread
            y = 0; // Shader will flip this to bottom: u_resolution.y - 0 = bottom
            baseDirection = Math.PI / 2 + (Math.random() - 0.5) * 0.8; // Downward in JS, upward on screen after shader flip
            baseSpeed = 1.5 + Math.random() * 1.0; // Faster upward motion
        }

        const colorIndex = this.getColorIndex(color);
        const vx = Math.cos(baseDirection + angleVariation) * baseSpeed * speedVariation;
        const vy = Math.sin(baseDirection + angleVariation) * baseSpeed * speedVariation;

        // Add to optimized TypedArrays
        const posIdx = this.particleCount * 2;
        const velIdx = this.particleCount * 2;

        this.particleData[posIdx] = x;
        this.particleData[posIdx + 1] = y;
        // Store velocities as scaled Int16 (-32768 to 32767, scaled by velocityScale)
        this.velocityData[velIdx] = Math.round(vx * this.velocityScale);
        this.velocityData[velIdx + 1] = Math.round(vy * this.velocityScale);
        this.colorIndexData[this.particleCount] = colorIndex;

        // Update cached color count incrementally
        const colorKey = this.colorToKey(color);
        this.cachedColorCounts[colorKey] = (this.cachedColorCounts[colorKey] || 0) + 1;

        this.particleCount++;
    }

    deleteParticles(color, countToDelete) {
        if (countToDelete <= 0 || this.particleCount === 0) {
            return;
        }

        const colorIndex = this.getColorIndex(color);
        const colorKey = this.colorToKey(color);
        let deleted = 0;
        let writeIndex = 0;

        // Use two-pointer technique: read all particles, write only those we want to keep
        // This efficiently compacts the arrays in a single pass
        for (let readIndex = 0; readIndex < this.particleCount; readIndex++) {
            const shouldDelete = this.colorIndexData[readIndex] === colorIndex && deleted < countToDelete;
            
            if (!shouldDelete) {
                // Keep this particle - copy it to the write position
                if (writeIndex !== readIndex) {
                    // Copy position data (2 floats)
                    const readPosIdx = readIndex * 2;
                    const writePosIdx = writeIndex * 2;
                    this.particleData[writePosIdx] = this.particleData[readPosIdx];
                    this.particleData[writePosIdx + 1] = this.particleData[readPosIdx + 1];
                    
                    // Copy velocity data (2 int16s)
                    const readVelIdx = readIndex * 2;
                    const writeVelIdx = writeIndex * 2;
                    this.velocityData[writeVelIdx] = this.velocityData[readVelIdx];
                    this.velocityData[writeVelIdx + 1] = this.velocityData[readVelIdx + 1];
                    
                    // Copy color index (1 byte)
                    this.colorIndexData[writeIndex] = this.colorIndexData[readIndex];
                }
                writeIndex++;
            } else {
                // Delete this particle - skip copying it
                deleted++;
            }
        }

        // Update particle count
        this.particleCount = writeIndex;

        // Update cached color count
        this.cachedColorCounts[colorKey] = Math.max(0, (this.cachedColorCounts[colorKey] || 0) - deleted);
    }

    updateParticles() {
        const now = performance.now();
        const deltaTime = (now - this.lastSpawnTime) / 1000; // Convert to seconds
        this.lastSpawnTime = now;

        // Accumulate spawn time for consistent rate regardless of frame rate
        this.spawnTimeAccumulator = (this.spawnTimeAccumulator || 0) + deltaTime;

        // Calculate how many particles should spawn based on accumulated time
        const particlesToSpawnThisFrame = Math.floor(this.spawnTimeAccumulator * this.spawnRatePerSecond);
        this.spawnTimeAccumulator -= particlesToSpawnThisFrame / this.spawnRatePerSecond; // Keep remainder

        const totalParticlesToSpawn = particlesToSpawnThisFrame;

        // Count colors that need particles
        let activeColors = 0;
        this.availableColors.forEach(colorData => {
            const colorKey = this.colorToKey(colorData.rgb);
            const targetCount = this.colorCounts[colorKey] || 0;
            const currentCount = this.cachedColorCounts[colorKey] || 0;
            if (targetCount > currentCount) {
                activeColors++;
            }
        });

        // Handle spawning if there are active colors
        if (activeColors > 0 && totalParticlesToSpawn > 0) {
            // Build list of active colors that need particles (maintain order from availableColors)
            const activeColorList = [];
            this.availableColors.forEach(colorData => {
                const colorKey = this.colorToKey(colorData.rgb);
                const targetCount = this.colorCounts[colorKey] || 0;
                const currentCount = this.cachedColorCounts[colorKey] || 0;
                if (targetCount > currentCount) {
                    activeColorList.push({
                        colorData: colorData,
                        colorKey: colorKey,
                        needed: targetCount - currentCount
                    });
                }
            });

            // Distribute particles fairly using persistent round-robin across frames
            // This ensures all colors get particles even when spawn rate is low
            // Start from where we left off in the previous frame
            if (activeColorList.length > 0) {
                // Ensure round-robin index is valid for current list
                if (this.roundRobinIndex >= activeColorList.length) {
                    this.roundRobinIndex = 0;
                }
                
                let particlesRemaining = totalParticlesToSpawn;
                let iterations = 0;
                const maxIterations = activeColorList.length * 1000; // Safety limit
                
                while (particlesRemaining > 0 && activeColorList.length > 0 && iterations < maxIterations) {
                    iterations++;
                    
                    // Validate index after potential removals
                    if (this.roundRobinIndex >= activeColorList.length) {
                        this.roundRobinIndex = 0;
                    }
                    
                    // Get current color from round-robin index
                    const activeColor = activeColorList[this.roundRobinIndex];
                    
                    if (activeColor && activeColor.needed > 0) {
                        // Spawn 1 particle for this color
                        this.ensureParticleCapacity(this.particleCount + 1);
                        this.createParticle(activeColor.colorData.rgb);
                        
                        activeColor.needed--;
                        particlesRemaining--;
                        
                        // Remove color if it reached its target
                        if (activeColor.needed === 0) {
                            activeColorList.splice(this.roundRobinIndex, 1);
                            // After removal, adjust index if necessary
                            if (activeColorList.length === 0) {
                                this.roundRobinIndex = 0;
                                break;
                            }
                            // If we removed the last element, wrap to beginning
                            if (this.roundRobinIndex >= activeColorList.length) {
                                this.roundRobinIndex = 0;
                            }
                            // Continue with current index (which now points to next color after removal)
                            continue;
                        }
                    }
                    
                    // Move to next color in round-robin
                    this.roundRobinIndex = (this.roundRobinIndex + 1) % activeColorList.length;
                }
            } else {
                // No active colors, reset round-robin index
                this.roundRobinIndex = 0;
            }
        } else if (activeColors === 0) {
            // No active colors, reset round-robin index
            this.roundRobinIndex = 0;
        }

        // Update particle positions (optimized for high particle counts)
        // Using separated arrays: positions (Float32) and velocities (Int16 scaled)
        const particleData = this.particleData;
        const velocityData = this.velocityData;
        const width = this.width;
        const height = this.height;
        const count = this.particleCount;
        const velScaleInv = this.velocityScaleInv; // Use cached inverse for faster multiplication
        
        // Optimized loop - convert Int16 velocities to floats on-the-fly
        // Cache velocity scale division for better performance
        for (let i = 0; i < count; i++) {
            const posIdx = i * 2;
            const velIdx = i * 2;
            
            // Convert scaled Int16 velocities back to floats (use multiplication for speed)
            const vx = velocityData[velIdx] * velScaleInv;
            const vy = velocityData[velIdx + 1] * velScaleInv;
            
            // Update position
            let x = particleData[posIdx] + vx;
            let y = particleData[posIdx + 1] + vy;
            
            // Optimized boundary wrapping - only check if needed
            // Most particles stay on screen, so we optimize the common case
            if (x < 0) {
                x += width;
            } else if (x >= width) {
                x -= width;
            }
            
            if (y < 0) {
                y += height;
            } else if (y >= height) {
                y -= height;
            }
            
            particleData[posIdx] = x;
            particleData[posIdx + 1] = y;
        }
        
        // Track particle speed using real-world clock time (for lag detection)
        // Increment frame counter for speed tracking
        if (this.particleCount > 0 && !this.isPaused) {
            this.frameCountForSpeedTracking++;
        }
        
        if (this.particleCount > 0 && !this.isPaused) {
            const now = performance.now();
            const realTimeDelta = (now - this.lastRealTimeCheck) / 1000; // Real time in seconds
            
            // Check every 100ms for accuracy
            if (realTimeDelta >= 0.1) {
                // Use first particle as reference (or random one if available)
                const refIdx = this.referenceParticleIndex % this.particleCount;
                const posIdx = refIdx * 2;
                const velIdx = refIdx * 2;
                
                const currentX = this.particleData[posIdx];
                const currentY = this.particleData[posIdx + 1];
                // Convert scaled Int16 velocities back to floats (use multiplication for speed)
                const vx = this.velocityData[velIdx] * this.velocityScaleInv;
                const vy = this.velocityData[velIdx + 1] * this.velocityScaleInv;
                
                // Calculate velocity magnitude (pixels per frame)
                const velocityMagnitude = Math.sqrt(vx * vx + vy * vy);
                
                // Initialize tracking if this is the first check
                if (this.referenceParticleLastX === 0 && this.referenceParticleLastY === 0) {
                    this.referenceParticleLastX = currentX;
                    this.referenceParticleLastY = currentY;
                    this.lastRealTimeCheck = now;
                    this.frameCountForSpeedTracking = 0;
                    return; // Skip calculation this frame, wait for next check
                }
                
                if (velocityMagnitude > 0 && this.frameCountForSpeedTracking > 0) {
                    // Calculate actual distance traveled
                    let distanceX = currentX - this.referenceParticleLastX;
                    let distanceY = currentY - this.referenceParticleLastY;
                    
                    // Handle wrapping (particle might have wrapped around screen)
                    if (Math.abs(distanceX) > this.width / 2) {
                        distanceX = distanceX > 0 ? distanceX - this.width : distanceX + this.width;
                    }
                    if (Math.abs(distanceY) > this.height / 2) {
                        distanceY = distanceY > 0 ? distanceY - this.height : distanceY + this.height;
                    }
                    
                    const actualDistance = Math.sqrt(distanceX * distanceX + distanceY * distanceY);
                    
                    // Calculate expected distance based on real-world time
                    // Expected: How far particle SHOULD move in real time if running at target FPS
                    // Velocity is pixels per frame, so we convert to pixels per second
                    // Use your target FPS (240) as the baseline expectation
                    const targetFPS = 240; // Your target/expected FPS
                    const expectedDistancePerSecond = velocityMagnitude * targetFPS;
                    const expectedDistance = expectedDistancePerSecond * realTimeDelta;
                    
                    // Calculate simulation speed (actual / expected)
                    // 100% = particles moving at expected speed (240 FPS)
                    // <100% = particles moving slower in real time (lagging - FPS dropped below 240)
                    // >100% = particles moving faster (FPS above 240)
                    if (expectedDistance > 0) {
                        this.simulationSpeed = actualDistance / expectedDistance;
                        // Clamp to reasonable range (0-2.0)
                        this.simulationSpeed = Math.max(0, Math.min(2.0, this.simulationSpeed));
                    }
                }
                
                // Store current position and velocity for next check
                this.referenceParticleLastX = currentX;
                this.referenceParticleLastY = currentY;
                this.referenceParticleVelocity = velocityMagnitude;
                this.lastRealTimeCheck = now;
                this.frameCountForSpeedTracking = 0; // Reset frame counter
            }
        } else if (this.particleCount === 0) {
            // Reset tracking when no particles
            this.referenceParticleLastX = 0;
            this.referenceParticleLastY = 0;
            this.simulationSpeed = 1.0;
            this.frameCountForSpeedTracking = 0;
        }
    }

    render() {
        if (!this.isPaused) {
            this.updateParticles();
        }
        
        // Update performance displays
        const particleCountDisplay = document.getElementById('particleCountDisplay');
        const fpsDisplay = document.getElementById('fpsDisplay');
        const memoryDisplay = document.getElementById('memoryDisplay');
        
        // Calculate FPS (only when not paused)
        if (!this.isPaused) {
            this.frameCount++;
        }
        const now = performance.now();
        const deltaTime = now - this.lastFpsUpdate;
        
        if (deltaTime >= 1000) { // Update every second
            if (!this.isPaused) {
                this.fps = Math.round((this.frameCount * 1000) / deltaTime);
            }
            this.frameCount = 0;
            this.lastFpsUpdate = now;
        }
        
        // Update displays
        if (particleCountDisplay) {
            particleCountDisplay.textContent = this.particleCount.toLocaleString();
        }
        
        if (fpsDisplay) {
            fpsDisplay.textContent = this.isPaused ? 'Paused' : (this.fps || 0).toString();
        }
        
        if (memoryDisplay) {
            const memoryUsage = this.calculateMemoryUsage();
            const particleMemoryMB = (memoryUsage.total.used / 1048576).toFixed(2);
            let browserMemory = 'N/A';
            if (performance.memory) {
                const heapUsedMB = (performance.memory.usedJSHeapSize / 1048576).toFixed(2);
                browserMemory = `${heapUsedMB} MB`;
            }
            memoryDisplay.textContent = `${particleMemoryMB} MB | ${browserMemory}`;
        }
        
        // Update current count displays (left side) to show actual particle counts
        this.availableColors.forEach((colorData, index) => {
            const colorKey = this.colorToKey(colorData.rgb);
            const currentCountDisplay = document.getElementById(`colorCurrentCount-${index}`);
            if (currentCountDisplay) {
                const actualCount = this.cachedColorCounts[colorKey] || 0;
                currentCountDisplay.textContent = actualCount.toLocaleString();
            }
        });
        
        // Clear canvas
        this.gl.clearColor(0.04, 0.04, 0.04, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        
        const currentCount = this.particleCount;
        
        // Skip rendering if no particles
        if (currentCount === 0 || !this.particleData || !this.velocityData || !this.colorIndexData) {
            return;
        }
        
        // Reuse buffers - only resize if needed
        if (!this.positionBufferData || this.positionBufferData.length < currentCount * 2) {
            this.positionBufferData = new Float32Array(currentCount * 2);
            this.colorIndexBufferData = new Float32Array(currentCount);
        }
        
        // Extract data from optimized TypedArrays into separate buffers
        // Cache references for faster access
        const particleData = this.particleData; // Positions: 2 floats per particle
        const colorIndexData = this.colorIndexData; // Color indices: 1 byte per particle (Uint8Array)
        const positionBufferData = this.positionBufferData;
        const colorIndexBufferData = this.colorIndexBufferData;
        
        // Optimized loop - copy positions and color indices directly
        for (let i = 0; i < currentCount; i++) {
            const posIdx = i * 2;

            // Position (direct copy - already in correct format)
            positionBufferData[posIdx] = particleData[posIdx];
            positionBufferData[posIdx + 1] = particleData[posIdx + 1];

            // Color index (convert Uint8 to float for attribute)
            colorIndexBufferData[i] = colorIndexData[i];
        }
        
        // Update buffers (using STREAM_DRAW for better performance with frequently changing data)
        // Optimize WebGL calls - only update what's necessary
        const gl = this.gl;
        
        // Position buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positionBufferData.subarray(0, currentCount * 2), gl.STREAM_DRAW);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
        
        // Color index buffer (replaces color buffer)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colorIndexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, colorIndexBufferData.subarray(0, currentCount), gl.STREAM_DRAW);
        gl.enableVertexAttribArray(this.colorIndexLocation);
        gl.vertexAttribPointer(this.colorIndexLocation, 1, gl.FLOAT, false, 0, 0);
        
        // Set uniforms
        gl.uniform2f(this.resolutionLocation, this.width, this.height);
        gl.uniform1f(this.sizeLocation, 1.5); // Constant size for all particles
        
        // Upload color palette as uniform array (cached, only needs to be uploaded once per frame)
        gl.uniform3fv(this.colorPaletteLocation, this.colorPaletteArray);
        
        // Draw particles
        gl.drawArrays(gl.POINTS, 0, currentCount);
    }

    animate() {
        this.render();
        this.animationFrameId = requestAnimationFrame(() => this.animate());
    }
    
    setupControls() {
        const pauseButton = document.getElementById('pauseButton');
        const restartButton = document.getElementById('restartButton');
        const fountainButton = document.getElementById('fountainButton');
        
        if (pauseButton) {
            pauseButton.addEventListener('click', () => {
                this.togglePause();
            });
        }
        
        if (restartButton) {
            restartButton.addEventListener('click', () => {
                this.restart();
            });
        }
        
        if (fountainButton) {
            // Initialize button text based on current spawn mode
            this.updateFountainButton();
            
            fountainButton.addEventListener('click', () => {
                // Cycle through: fountain → wind → rain → fountain
                if (this.spawnMode === 'fountain') {
                    this.spawnMode = 'wind';
                } else if (this.spawnMode === 'wind') {
                    this.spawnMode = 'rain';
                } else {
                    this.spawnMode = 'fountain';
                }
                this.updateFountainButton();
            });
        }
    }
    
    updateFountainButton() {
        const fountainButton = document.getElementById('fountainButton');
        if (fountainButton) {
            // Display current mode name
            const modeNames = {
                'fountain': 'Fountain',
                'wind': 'Wind',
                'rain': 'Rain'
            };
            fountainButton.textContent = modeNames[this.spawnMode] || 'Fountain';
        }
    }
    
    togglePause() {
        this.isPaused = !this.isPaused;
        const pauseButton = document.getElementById('pauseButton');
        
        if (this.isPaused) {
            if (pauseButton) {
                pauseButton.textContent = 'Resume';
                pauseButton.classList.add('paused');
            }
        } else {
            if (pauseButton) {
                pauseButton.textContent = 'Pause';
                pauseButton.classList.remove('paused');
            }
            // Reset spawn time to avoid huge delta when resuming
            this.lastSpawnTime = performance.now();
            // Resume animation if paused
            if (!this.animationFrameId) {
                this.animate();
            }
        }
    }
    
    restart() {
        // Clear all particles
        this.particleCount = 0;
        this.particlesToSpawn = 0;

        // Reset all color counts
        Object.keys(this.colorCounts).forEach(key => {
            this.colorCounts[key] = 0;
            this.cachedColorCounts[key] = 0;
        });

        // Reset spawn timing accumulator and round-robin index
        this.spawnTimeAccumulator = 0;
        this.roundRobinIndex = 0;

        // Reset all color sliders
        this.availableColors.forEach((colorData, index) => {
            const colorSlider = document.getElementById(`colorSlider-${index}`);
            const currentCountDisplay = document.getElementById(`colorCurrentCount-${index}`);
            const targetCountDisplay = document.getElementById(`colorTargetCount-${index}`);
            if (colorSlider) {
                colorSlider.value = 0;
            }
            if (currentCountDisplay) {
                currentCountDisplay.textContent = '0';
            }
            if (targetCountDisplay) {
                targetCountDisplay.textContent = '0';
            }
        });

        // Reset spawn rate toggle button (default to 1K)
        this.currentSpawnRateIndex = 0;
        this.spawnRatePerSecond = 1000;
        this.updateSpawnRateButton();
        
        // Reset spawn mode to fountain
        this.spawnMode = 'fountain';
        this.updateFountainButton();

        // Resume if paused
        if (this.isPaused) {
            this.togglePause();
        }
    }
    
    /**
     * Get detailed performance metrics for analytics
     * Returns object with FPS, memory, particle stats, etc.
     * Useful for performance monitoring and debugging
     * 
     * Usage: const metrics = particleSystem.getPerformanceMetrics();
     *        console.log(metrics); // See detailed breakdown
     */
    getPerformanceMetrics() {
        const memoryUsage = this.calculateMemoryUsage();
        
        const metrics = {
            fps: this.fps,
            particleCount: this.particleCount,
            particleCapacity: this.particleCapacity,
            spawnRate: this.spawnRatePerSecond,
            isPaused: this.isPaused,
            memory: {
                particles: {
                    used: {
                        bytes: memoryUsage.total.used,
                        mb: memoryUsage.total.used / 1048576,
                        formatted: (memoryUsage.total.used / 1048576).toFixed(2) + ' MB'
                    },
                    allocated: {
                        bytes: memoryUsage.total.allocated,
                        mb: memoryUsage.total.allocated / 1048576,
                        formatted: (memoryUsage.total.allocated / 1048576).toFixed(2) + ' MB'
                    },
                    bytesPerParticle: memoryUsage.total.bytesPerParticle,
                    breakdown: {
                        particleStorage: {
                            used: memoryUsage.particleStorage.used,
                            allocated: memoryUsage.particleStorage.allocated,
                            overhead: memoryUsage.particleStorage.overhead,
                            overheadPercent: memoryUsage.particleStorage.allocated > 0 
                                ? ((memoryUsage.particleStorage.overhead / memoryUsage.particleStorage.allocated) * 100).toFixed(1) + '%'
                                : '0%'
                        },
                        renderingBuffers: {
                            allocated: memoryUsage.renderingBuffers.allocated
                        }
                    }
                },
                browser: null
            },
            colorCounts: { ...this.colorCounts }
        };
        
        // Add browser memory if available (Chrome's performance.memory API)
        if (performance.memory) {
            metrics.memory.browser = {
                used: {
                    bytes: performance.memory.usedJSHeapSize,
                    mb: performance.memory.usedJSHeapSize / 1048576,
                    formatted: (performance.memory.usedJSHeapSize / 1048576).toFixed(2) + ' MB'
                },
                total: {
                    bytes: performance.memory.totalJSHeapSize,
                    mb: performance.memory.totalJSHeapSize / 1048576,
                    formatted: (performance.memory.totalJSHeapSize / 1048576).toFixed(2) + ' MB'
                },
                limit: {
                    bytes: performance.memory.jsHeapSizeLimit,
                    mb: performance.memory.jsHeapSizeLimit / 1048576,
                    formatted: (performance.memory.jsHeapSizeLimit / 1048576).toFixed(0) + ' MB'
                },
                // Calculate what percentage of browser heap is used by particles
                particlePercentage: performance.memory.usedJSHeapSize > 0 
                    ? ((memoryUsage.total.used / performance.memory.usedJSHeapSize) * 100).toFixed(2) + '%'
                    : '0%'
            };
        }
        
        return metrics;
    }
}

// Initialize particle system when page loads
window.addEventListener('load', () => {
    try {
        const canvas = document.getElementById('particleCanvas');
        if (!canvas) {
            return;
        }
        window.particleSystem = new ParticleSystem(canvas);
        
        // Expose metrics access for debugging/analytics
        // Usage: particleSystem.getPerformanceMetrics() in console
    } catch (error) {
        // Display user-friendly error message
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(255, 0, 0, 0.1); color: #ff6b6b; padding: 20px; border-radius: 8px; border: 1px solid #ff6b6b; z-index: 1000; font-family: monospace;';
        errorDiv.textContent = 'Failed to initialize particle system. Please check browser console for details.';
        document.body.appendChild(errorDiv);
    }
});
