#import "raster-encoding.h"
#import "protocol.h"
#include <algorithm>
#include <cmath>
#include <vector>
#ifndef KCODE_INLINE_FRAME_BYTES
#error Build must supply the canonical inline raster budget
#endif
// Host 的帧契约（domain/frame.ts）只接受单边不超过 4096 的栅格；截图路径允许到 8192。
static const NSUInteger KCUA_RASTER_MAX_SIDE = 4096;
NSDictionary *KCUAEncodeRaster(NSData *png, NSUInteger width, NSUInteger height,
                               void (^checkpoint)(void)) {
  if (checkpoint)
    checkpoint();
  if (!png.length || !width || !height)
    KCUAFail(@"element_unavailable", @"Capture raster is empty");
  // 修复原因：PNG 足够小时原先不看边长直接原样返回。宽而好压缩的窗口（例如 5000×500）因此
  // 超过 Host 的 4096 上限，Host 读栅格身份时得到 undefined，整次观察报 invalid_response。
  bool oversized = width > KCUA_RASTER_MAX_SIDE || height > KCUA_RASTER_MAX_SIDE;
  if (!oversized && png.length <= KCODE_INLINE_FRAME_BYTES)
    return @{
      @"bytes" : png,
      @"format" : @"png",
      @"width" : @(width),
      @"height" : @(height)
    };
  NSBitmapImageRep *source = [NSBitmapImageRep imageRepWithData:png];
  if (!source || source.pixelsWide != (NSInteger)width ||
      source.pixelsHigh != (NSInteger)height)
    KCUAFail(@"element_unavailable",
             @"Capture raster header differs from its surface dimensions");
  CGImageRef original = source.CGImage;
  // 超边长的栅格先按 Host 上限等比缩小，尽量保持无损（先试 PNG）；放不下再走原有的 JPEG 阶梯。
  std::vector<NSUInteger> bounds = {1280u, 960u, 720u, 512u};
  if (oversized)
    bounds.insert(bounds.begin(), KCUA_RASTER_MAX_SIDE);
  for (NSUInteger bound : bounds) {
    if (checkpoint)
      checkpoint();
    double ratio = std::min(1.0, (double)bound / std::max(width, height));
    NSUInteger w = MAX((NSUInteger)1, (NSUInteger)floor(width * ratio)),
               h = MAX((NSUInteger)1, (NSUInteger)floor(height * ratio));
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(nullptr, w, h, 8, 0, space,
                                                 kCGImageAlphaNoneSkipLast |
                                                     kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(space);
    if (!context)
      KCUAFail(@"element_unavailable", @"Cannot allocate final raster encoder");
    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGContextSetRGBFillColor(context, 1, 1, 1, 1);
    CGContextFillRect(context, CGRectMake(0, 0, w, h));
    CGContextDrawImage(context, CGRectMake(0, 0, w, h), original);
    CGImageRef resized = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    NSBitmapImageRep *bitmap =
        [[NSBitmapImageRep alloc] initWithCGImage:resized];
    CGImageRelease(resized);
    if (oversized && bound == KCUA_RASTER_MAX_SIDE) {
      NSData *lossless =
          [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      if (lossless.length && lossless.length <= KCODE_INLINE_FRAME_BYTES)
        return @{
          @"bytes" : lossless,
          @"format" : @"png",
          @"width" : @(w),
          @"height" : @(h)
        };
    }
    for (double quality : {0.85, 0.65, 0.45, 0.25, 0.1}) {
      if (checkpoint)
        checkpoint();
      NSData *bytes =
          [bitmap representationUsingType:NSBitmapImageFileTypeJPEG
                               properties:@{
                                 NSImageCompressionFactor : @(quality),
                                 NSImageProgressive : @NO
                               }];
      if (bytes.length && bytes.length <= KCODE_INLINE_FRAME_BYTES)
        return @{
          @"bytes" : bytes,
          @"format" : @"jpeg",
          @"width" : @(w),
          @"height" : @(h)
        };
    }
  }
  KCUAFail(@"element_unavailable",
           @"Capture cannot fit the immutable model raster budget");
}
