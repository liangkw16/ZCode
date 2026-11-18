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
    puts("native raster budget and immutable small PNG passed");
  }
}
