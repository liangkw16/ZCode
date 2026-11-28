#import "../native/macos/raster-encoding.h"
#include <cassert>
int main(void) {
  @autoreleasepool {
    NSBitmapImageRep *small =
        [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr
                                                pixelsWide:2
                                                pixelsHigh:2
                                             bitsPerSample:8
                                           samplesPerPixel:4
                                                  hasAlpha:YES
                                                  isPlanar:NO
                                            colorSpaceName:NSDeviceRGBColorSpace
                                               bytesPerRow:8
                                              bitsPerPixel:32];
    memset(small.bitmapData, 255, 16);
    NSData *png = [small representationUsingType:NSBitmapImageFileTypePNG
                                      properties:@{}];
    NSDictionary *unchanged = KCUAEncodeRaster(png, 2, 2);
    assert([unchanged[@"format"] isEqual:@"png"]);
    assert([unchanged[@"bytes"] isEqual:png]);
    NSUInteger width = 2048, height = 1024;
    NSBitmapImageRep *large =
        [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr
                                                pixelsWide:width
                                                pixelsHigh:height
                                             bitsPerSample:8
                                           samplesPerPixel:4
                                                  hasAlpha:YES
                                                  isPlanar:NO
                                            colorSpaceName:NSDeviceRGBColorSpace
                                               bytesPerRow:width * 4
                                              bitsPerPixel:32];
    uint32_t seed = 31;
    for (NSUInteger i = 0; i < width * height; i++) {
      for (NSUInteger c = 0; c < 3; c++) {
        seed = 1664525 * seed + 1013904223;
        large.bitmapData[i * 4 + c] = (uint8_t)(seed >> 24);
      }
      large.bitmapData[i * 4 + 3] = 255;
    }
    NSData *largePNG =
        [large representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    __block NSUInteger checkpoints = 0;
    @try {
      KCUAEncodeRaster(largePNG, width, height, ^{
        if (++checkpoints == 3)
          @throw [NSException exceptionWithName:@"fixture_cancelled"
                                         reason:nil
                                       userInfo:nil];
      });
      assert(false && "Raster encoding ignored cancellation during fallback");
    } @catch (NSException *error) {
      assert([error.name isEqual:@"fixture_cancelled"] && checkpoints == 3);
    }
    NSDictionary *encoded = KCUAEncodeRaster(largePNG, width, height);
    NSData *bytes = encoded[@"bytes"];
    assert([bytes base64EncodedStringWithOptions:0].length <= 204800);
    NSBitmapImageRep *decoded = [NSBitmapImageRep imageRepWithData:bytes];
    assert(decoded);
    assert(decoded.pixelsWide == [encoded[@"width"] integerValue]);
    assert(decoded.pixelsHigh == [encoded[@"height"] integerValue]);
    assert(decoded.pixelsWide <= 1280 && decoded.pixelsHigh <= 640);

    // 修复回归：宽而好压缩的窗口（5000×500 双色）PNG 远小于字节预算，原先不看边长原样返回，
    // 超过 Host 的 4096 上限后整次观察会被判成 invalid_response。
    NSUInteger wideWidth = 5000, wideHeight = 500;
    NSBitmapImageRep *wide =
        [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr
                                                pixelsWide:wideWidth
                                                pixelsHigh:wideHeight
                                             bitsPerSample:8
                                           samplesPerPixel:4
                                                  hasAlpha:YES
                                                  isPlanar:NO
                                            colorSpaceName:NSDeviceRGBColorSpace
                                               bytesPerRow:wideWidth * 4
                                              bitsPerPixel:32];
    memset(wide.bitmapData, 0, wideWidth * wideHeight * 4);
    for (NSUInteger i = 0; i < wideWidth * wideHeight; i++)
      wide.bitmapData[i * 4 + 3] = 255;
    NSData *widePNG =
        [wide representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    assert(widePNG.length < 153600);
    NSDictionary *scaled = KCUAEncodeRaster(widePNG, wideWidth, wideHeight);
    assert([scaled[@"width"] integerValue] == 4096);
    assert([scaled[@"height"] integerValue] == 409);
    assert([scaled[@"format"] isEqual:@"png"]);
    assert([scaled[@"bytes"] length] <= 153600);
    NSBitmapImageRep *scaledDecoded =
        [NSBitmapImageRep imageRepWithData:scaled[@"bytes"]];
    assert(scaledDecoded.pixelsWide == 4096 && scaledDecoded.pixelsHigh == 409);
    puts("native raster budget, immutable small PNG and wide-window side limit passed");
  }
}
