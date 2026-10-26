import AppKit

let destination = CommandLine.arguments[1]
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let p = CGFloat(pixels)
        NSColor(calibratedWhite: 0.08, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: p * 0.04, y: p * 0.04, width: p * 0.92, height: p * 0.92),
                     xRadius: p * 0.2, yRadius: p * 0.2).fill()
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: p * 0.37, weight: .semibold),
            .foregroundColor: NSColor(calibratedRed: 0.48, green: 0.86, blue: 0.71, alpha: 1),
        ]
        let label = NSString(string: ">_")
        let measured = label.size(withAttributes: attributes)
        label.draw(at: NSPoint(x: (p - measured.width) / 2, y: (p - measured.height) / 2), withAttributes: attributes)
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(
            to: URL(fileURLWithPath: "\(destination)/icon_\(size)x\(size)\(suffix).png"))
    }
}
