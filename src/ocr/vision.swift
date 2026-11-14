// Reads text from one image or PDF with macOS Vision, offline. Usage: vision <file> <maxPages>.
// Prints one JSON line: {"totalPages":N,"pages":[{"page":1,"text":"...","confidence":0.93}]} or {"error":"..."}.
import Foundation
import Vision
import ImageIO
import CoreGraphics

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

// About 200 dpi for a Letter or A4 page: Vision reads small CJK print well from here, and a page stays near 4 MP.
let pdfLongSide: CGFloat = 2200

// On white, so dark text on a transparent background stays readable.
func onWhite(width: Int, height: Int, draw: (CGContext) -> Void) -> CGImage? {
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    draw(context)
    return context.makeImage()
}

func render(_ page: CGPDFPage) -> CGImage? {
    let box = page.getBoxRect(.mediaBox)
    let scale = pdfLongSide / max(box.width, box.height)
    return onWhite(width: Int(box.width * scale), height: Int(box.height * scale)) { context in
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -box.minX, y: -box.minY)
        context.drawPDFPage(page)
    }
}

func flatten(_ image: CGImage?) -> CGImage? {
    guard let image = image else { return nil }
    return onWhite(width: image.width, height: image.height) { $0.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height)) }
}

func recognize(_ image: CGImage, orientation: CGImagePropertyOrientation) throws -> (String, Double?) {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
    try VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:]).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first }
    let confidence = lines.isEmpty ? nil : Double(lines.map { $0.confidence }.reduce(0, +)) / Double(lines.count)
    return (lines.map { $0.string }.joined(separator: "\n"), confidence)
}

func page(_ number: Int, _ image: CGImage?, _ orientation: CGImagePropertyOrientation) throws -> [String: Any] {
    guard let image = image else { return ["page": number, "text": "", "confidence": NSNull()] }
    let (text, confidence) = try recognize(image, orientation: orientation)
    return ["page": number, "text": text, "confidence": confidence.map { $0 as Any } ?? NSNull()]
}

let args = CommandLine.arguments
guard args.count == 3, let maxPages = Int(args[2]), maxPages > 0 else {
    emit(["error": "usage: vision <file> <maxPages>"])
    exit(2)
}
let url = URL(fileURLWithPath: args[1])
do {
    var pages: [[String: Any]] = []
    var total = 0
    let head = (try? FileHandle(forReadingFrom: url).readData(ofLength: 5)) ?? Data()
    if head == "%PDF-".data(using: .ascii), let pdf = CGPDFDocument(url as CFURL) {
        if pdf.isEncrypted && !pdf.isUnlocked { emit(["error": "encrypted"]); exit(0) }
        total = pdf.numberOfPages
        for n in 0..<min(total, maxPages) { pages.append(try page(n + 1, pdf.page(at: n + 1).flatMap(render), .up)) }
    } else if let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0 {
        total = CGImageSourceGetCount(source)
        for n in 0..<min(total, maxPages) {
            let properties = CGImageSourceCopyPropertiesAtIndex(source, n, nil) as? [CFString: Any]
            let raw = (properties?[kCGImagePropertyOrientation] as? UInt32) ?? 1
            pages.append(try page(n + 1, flatten(CGImageSourceCreateImageAtIndex(source, n, nil)), CGImagePropertyOrientation(rawValue: raw) ?? .up))
        }
    } else {
        emit(["error": "unreadable"])
        exit(0)
    }
    emit(["totalPages": total, "pages": pages])
} catch {
    emit(["error": "vision: \(error.localizedDescription)"])
}
