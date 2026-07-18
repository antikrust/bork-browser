// SPDX-License-Identifier: MPL-2.0
//
// Make the paper around the face crop transparent.
//
// A colour key ("white -> alpha") would also hollow out the eye whites, which
// are the same white as the paper — only their enclosure by ink tells them
// apart. So: flood-fill from the image border instead. Everything paper-ish
// reachable from outside goes transparent, and the anti-aliased rim becomes
// black at inverse-luminance alpha so no pale fringe survives on a dark Dock.
//
//   swift tools/release/face-alpha.swift in.png [out.png]   (in place if no out)

import Foundation
import CoreGraphics
import ImageIO

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write(Data("usage: face-alpha.swift in.png [out.png]\n".utf8))
  exit(1)
}
let inPath = args[1]
let outPath = args.count > 2 ? args[2] : args[1]

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: inPath) as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
else {
  FileHandle.standardError.write(Data("cannot read \(inPath)\n".utf8))
  exit(1)
}

let w = img.width
let h = img.height
guard let ctx = CGContext(
  data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
  space: CGColorSpace(name: CGColorSpace.sRGB)!,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { exit(1) }
ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
let buf = ctx.data!.bindMemory(to: UInt8.self, capacity: w * h * 4)

// Unpremultiplied luminance; already-transparent pixels count as paper.
func lum(_ i: Int) -> Int {
  let a = Int(buf[i + 3])
  if a == 0 { return 255 }
  let r = Int(buf[i]) * 255 / a
  let g = Int(buf[i + 1]) * 255 / a
  let b = Int(buf[i + 2]) * 255 / a
  return (r * 299 + g * 587 + b * 114) / 1000
}

var visited = [Bool](repeating: false, count: w * h)
var queue: [Int] = []
for x in 0..<w { queue.append(x); queue.append((h - 1) * w + x) }
for y in 0..<h { queue.append(y * w); queue.append(y * w + (w - 1)) }

var head = 0
while head < queue.count {
  let p = queue[head]
  head += 1
  if visited[p] { continue }
  let i = p * 4
  let l = lum(i)
  if l < 64 && buf[i + 3] > 16 { continue } // ink: the fill stops here
  visited[p] = true
  // Paper and rim become black at 255-luminance alpha; premultiplied black
  // is all zeroes, so only the alpha byte carries information.
  buf[i] = 0
  buf[i + 1] = 0
  buf[i + 2] = 0
  buf[i + 3] = UInt8(clamping: 255 - l)
  let x = p % w
  if x > 0 { queue.append(p - 1) }
  if x < w - 1 { queue.append(p + 1) }
  if p >= w { queue.append(p - w) }
  if p < (h - 1) * w { queue.append(p + w) }
}

guard let out = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(
        URL(fileURLWithPath: outPath) as CFURL, "public.png" as CFString, 1, nil)
else { exit(1) }
CGImageDestinationAddImage(dest, out, nil)
guard CGImageDestinationFinalize(dest) else {
  FileHandle.standardError.write(Data("cannot write \(outPath)\n".utf8))
  exit(1)
}
print("transparent: \(outPath)")
