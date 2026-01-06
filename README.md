# WebGL Particle Simulation

![Particle Simulation](picture1.jpg)

Built with Vanilla JavaScript and WebGL

### Memory Optimization
- **Particle Storage**: Optimized TypedArrays
- Positions: Float32Array (8 bytes per particle)
- Velocities: Int16Array scaled by 1000 (4 bytes per particle)
- Color indices: Uint8Array (1 byte per particle)
- **Total: 13 bytes per particle** (reduced from 17 bytes)

### Rendering
- WebGL 2.0 shaders for GPU-accelerated rendering
- Point-based particle rendering with smooth alpha blending
- Color palette system for efficient memory usage
- Dynamic buffer allocation for optimal performance
