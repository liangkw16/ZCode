#import "../native/macos/automation.h"
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <cassert>
#include <cstring>

extern void KCUAWaitForCaptureCompletion(dispatch_semaphore_t, void (^)(void))
    __attribute__((weak_import));
#import <objc/runtime.h>

void KCUACheck(const KCUAOp &) {}
void KCUAValidateTarget(const KCUATargetRef &, bool) {}
CGRect KCUAAXBounds(AXUIElementRef) { return CGRectZero; }
NSString *KCUAGeneration(void) { return @"fixture"; }
void KCUARequireDesktop(void) {}

static unsigned encodedInCallback = 0;
static NSData *countEncoding(id, SEL, NSBitmapImageFileType, NSDictionary *) {
  ++encodedInCallback;
  return [NSData data];
}

int main() {
  @autoreleasepool {
    CVPixelBufferRef buffer = nullptr;
    assert(CVPixelBufferCreate(nullptr, 4, 3, kCVPixelFormatType_32BGRA,
                               nullptr, &buffer) == kCVReturnSuccess);
    assert(CVPixelBufferLockBaseAddress(buffer, 0) == kCVReturnSuccess);
    auto *pixels = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(buffer));
    size_t stride = CVPixelBufferGetBytesPerRow(buffer);
    for (size_t y = 0; y < 3; ++y)
      for (size_t x = 0; x < 4; ++x) {
        auto *pixel = pixels + y * stride + x * 4;
        pixel[0] = static_cast<uint8_t>(y * 10 + x);
        pixel[1] = 23;
        pixel[2] = 47;
        pixel[3] = 255;
      }
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    CMVideoFormatDescriptionRef format = nullptr;
    assert(CMVideoFormatDescriptionCreateForImageBuffer(nullptr, buffer,
                                                        &format) == noErr);
    CMSampleBufferRef sample = nullptr;
    CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    assert(CMSampleBufferCreateReadyWithImageBuffer(nullptr, buffer, format,
                                                    &timing, &sample) == noErr);
    CFArrayRef attachments =
        CMSampleBufferGetSampleAttachmentsArray(sample, true);
    auto *info =
        (__bridge NSMutableDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    info[SCStreamFrameInfoStatus] = @(SCFrameStatusComplete);
    info[SCStreamFrameInfoScaleFactor] = @1;
    info[SCStreamFrameInfoContentRect] = CFBridgingRelease(
        CGRectCreateDictionaryRepresentation(CGRectMake(1, 1, 2, 2)));

    // 运行生产回调。拦截编码调用，直接观察回调是否在交付像素前压缩图片。
    id<SCStreamOutput> output = [NSClassFromString(@"KCUAFrameOutput") new];
    assert(output);
    Method method = class_getInstanceMethod(
        NSBitmapImageRep.class, @selector(representationUsingType:properties:));
    IMP previous = method_setImplementation(method, (IMP)countEncoding);
    [output stream:(SCStream *)nil
        didOutputSampleBuffer:sample
                       ofType:SCStreamOutputTypeScreen];
    method_setImplementation(method, previous);
    assert(encodedInCallback == 0 &&
           "Frame callback compressed before capture could stop");

    id stored = [(id)output valueForKey:@"raster"];
    CGImageRef raster = (__bridge CGImageRef)stored;
    assert(raster && CGImageGetWidth(raster) == 2 &&
           CGImageGetHeight(raster) == 2);
    assert(CVPixelBufferLockBaseAddress(buffer, 0) == kCVReturnSuccess);
    memset(CVPixelBufferGetBaseAddress(buffer), 0, stride * 3);
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    CFRelease(sample);
    CFRelease(format);
    CVPixelBufferRelease(buffer);

    CFDataRef bytes = CGDataProviderCopyData(CGImageGetDataProvider(raster));
    assert(bytes && CFDataGetLength(bytes) == 16);
    const UInt8 *rgba = CFDataGetBytePtr(bytes);
    assert(rgba[0] == 11 && rgba[4] == 12 && rgba[8] == 21 && rgba[12] == 22);
    CFRelease(bytes);
    puts("capture callback publishes owned crop without encoding");

    assert(KCUAWaitForCaptureCompletion &&
           "Single-shot capture lacks a completion fence");
    auto ready = dispatch_semaphore_create(0);
    __block BOOL finished = NO;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150000000),
                   dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                     finished = YES;
                     dispatch_semaphore_signal(ready);
                   });
    @try {
      KCUAWaitForCaptureCompletion(ready, ^{
        KCUAFail(@"cancelled", @"test cancellation");
      });
      assert(false && "Cancelled capture returned a frame");
    } @catch (NSException *error) {
      assert([error.name isEqual:@"cancelled"] && finished);
    }
    puts("single-shot cancellation waits for the framework callback");
  }
}
