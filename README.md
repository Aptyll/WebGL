# WebGL Particle Simulation

![Particle Simulation](picture1.jpg)

A high-performance WebGL 2.0 particle simulation system capable of rendering up to 1 million particles in real-time. Features multiple particle modes (Fountain, Wind, Rain), customizable colors, and real-time performance metrics.

## Features

### 🎨 Multiple Particle Modes
- **Fountain Mode**: Particles spawn from the bottom center and arc upward
- **Wind Mode**: Particles flow horizontally from left to right
- **Rain Mode**: Particles fall straight down from the top with realistic speed

### 🎨 Customizable Colors
- Six predefined colors (Blue, Purple, Pink, Yellow, Red, White)
- Individual sliders for each color (0-500,000 particles)
- Real-time particle count display
- MAX button for quick maximum particle count

### ⚡ Performance
- **Up to 1 million particles** supported
- Memory-optimized particle storage (13 bytes per particle)
- Real-time FPS monitoring
- Memory usage tracking
- Adjustable spawn rates (1K, 10K, 100K particles/second)

### 🎮 Controls
- **Spawn Rate Toggle**: Cycle through 1K, 10K, 100K particles/second
- **Mode Button**: Cycle through Fountain → Wind → Rain modes
- **Pause/Resume**: Freeze animation
- **Restart**: Clear all particles and reset

## Technical Details

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

### Performance Features
- Round-robin particle distribution for fair color spawning
- Frame-accurate spawn timing regardless of FPS
- Real-time performance metrics (FPS, memory, particle count)
- Optimized update loops with minimal allocations

## Browser Requirements

- **WebGL 2.0 support** (Chrome 56+, Firefox 51+, Safari 15+, Edge 79+)
- Modern JavaScript engine
- Hardware-accelerated graphics recommended

## Usage

1. Open `index.html` in a WebGL 2.0 compatible browser
2. Use the color sliders to set target particle counts for each color
3. Adjust spawn rate using the 1K/10K/100K button
4. Toggle between Fountain/Wind/Rain modes
5. Monitor performance metrics in the top panel

### Controls Reference

| Control | Function |
|---------|----------|
| Color Sliders | Set target particle count (0-500,000) |
| MAX Button | Set slider to maximum value |
| Spawn Rate (1K/10K/100K) | Adjust particles spawned per second |
| Fountain/Wind/Rain | Cycle through particle modes |
| Pause | Freeze animation |
| Restart | Clear all particles and reset |

## Performance Tips

- Lower spawn rates (1K) for smoother performance with many particles
- Use fewer active colors to reduce computational overhead
- Monitor FPS to find optimal particle counts for your system
- Higher spawn rates (100K) work best with fewer total particles

## File Structure

```
.
├── index.html      # Main HTML file with UI controls
├── particles.js    # Particle simulation engine
└── picture1.jpg    # Project screenshot
```

## License

This project is open source and available for use and modification.

## Credits

Built with vanilla JavaScript and WebGL 2.0 for maximum performance and compatibility.

