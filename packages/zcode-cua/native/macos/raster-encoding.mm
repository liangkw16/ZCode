#import "raster-encoding.h"
#import "protocol.h"
#include <algorithm>
#include <cmath>
#ifndef KCODE_INLINE_FRAME_BYTES
#error Build must supply the canonical inline raster budget
#endif
NSDictionary *KCUAEncodeRaster(NSData *png, NSUInteger width, NSUInteger height,
                               void (^checkpoint)(void)) {
  if (checkpoint)
    checkpoint();
  if (!png.length || !width || !height)
    KCUAFail(@"element_unavailable", @"Capture raster is empty");
  if (png.length <= KCODE_INLINE_FRAME_BYTES)
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
  for (NSUInteger bound : {1280u, 960u, 720u, 512u}) {
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
