import AppKit

// Draws web/favicon.svg (32-unit grid: dark rounded square, violet eight-point mark) at each icon size.
let destination = CommandLine.arguments[1]
let background = NSColor(srgbRed: 0x12 / 255, green: 0x12 / 255, blue: 0x14 / 255, alpha: 1)
let mark = NSColor(srgbRed: 0x8b / 255, green: 0x80 / 255, blue: 0xff / 255, alpha: 1)
let strokes: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [(16, 6, 16, 26), (6, 16, 26, 16), (9, 9, 23, 23), (9, 23, 23, 9)]

for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        // An explicit bitmap keeps the pixel size exact whatever the build machine's display scale.
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                      samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let p = CGFloat(pixels)
        // macOS icons leave a margin around the tile; the favicon's 32 units map onto the tile.
        let inset = p * 0.04, unit = p * 0.92 / 32
        func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: inset + x * unit, y: inset + (32 - y) * unit) }
        background.setFill()
        NSBezierPath(roundedRect: NSRect(x: inset, y: inset, width: 32 * unit, height: 32 * unit),
                     xRadius: 7 * unit, yRadius: 7 * unit).fill()
        let path = NSBezierPath()
        for (x1, y1, x2, y2) in strokes {
            path.move(to: point(x1, y1))
            path.line(to: point(x2, y2))
        }
        path.lineWidth = 3 * unit
        path.lineCapStyle = .round
        mark.setStroke()
        path.stroke()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(
            to: URL(fileURLWithPath: "\(destination)/icon_\(size)x\(size)\(suffix).png"))
    }
}
