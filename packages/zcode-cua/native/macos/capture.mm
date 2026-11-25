#import "automation.h"
#import "raster-encoding.h"
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <chrono>
#include <cmath>
#include <cstring>

static CGImageRef copyRaster(CVPixelBufferRef buffer, CGRect crop,
                             BOOL *blank) {
  size_t width = (size_t)crop.size.width, height = (size_t)crop.size.height;
  if (width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024 ||
      CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA ||
      CVPixelBufferIsPlanar(buffer))
    return nullptr;
  size_t rowBytes = width * 4;
  NSMutableData *data = [NSMutableData dataWithLength:rowBytes * height];
  auto *pixels = static_cast<uint8_t *>(data.mutableBytes);
  if (!pixels || CVPixelBufferLockBaseAddress(
                     buffer, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess)
    return nullptr;
  const auto *source =
      static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(buffer));
  size_t stride = CVPixelBufferGetBytesPerRow(buffer);
  if (!source || stride < CVPixelBufferGetWidth(buffer) * 4) {
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    return nullptr;
  }
  source += (size_t)crop.origin.y * stride + (size_t)crop.origin.x * 4;
  for (size_t y = 0; y < height; ++y)
    std::memcpy(pixels + y * rowBytes, source + y * stride, rowBytes);
  CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);

  *blank = YES;
  for (size_t y = 0; y < height && *blank; y += MAX((size_t)1, height / 12))
    for (size_t x = 0; x < width; x += MAX((size_t)1, width / 12)) {
      const uint8_t *pixel = pixels + y * rowBytes + x * 4;
      if (std::memcmp(pixel, pixels, 3) != 0) {
        *blank = NO;
        break;
      }
    }

  CGDataProviderRef provider =
      CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
  if (!provider)
    return nullptr;
  CGColorSpaceRef colors = CGColorSpaceCreateDeviceRGB();
  CGImageRef image = CGImageCreate(
      width, height, 8, 32, rowBytes, colors,
      kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little, provider,
      nullptr, false, kCGRenderingIntentDefault);
  CGColorSpaceRelease(colors);
  CGDataProviderRelease(provider);
  return image;
}

@interface KCUAFrameOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic) dispatch_semaphore_t ready;
@property(nonatomic, strong) id raster;
@property(nonatomic, strong) NSError *failure;
@property(nonatomic) BOOL finished;
@property(nonatomic) BOOL blank;
@end
@implementation KCUAFrameOutput
- (instancetype)init {
  if ((self = [super init]))
    _ready = dispatch_semaphore_create(0);
  return self;
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  (void)stream;
  @synchronized(self) {
    if (!_finished) {
      _failure = error;
      _finished = YES;
      dispatch_semaphore_signal(_ready);
    }
  }
}
- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample))
    return;
  @synchronized(self) {
    if (_finished)
      return;
    NSArray *attachments = CFBridgingRelease(
        CMSampleBufferGetSampleAttachmentsArray(sample, false)
            ? CFRetain(CMSampleBufferGetSampleAttachmentsArray(sample, false))
            : nullptr);
    NSDictionary *info = attachments.firstObject;
    if ([info[SCStreamFrameInfoStatus] integerValue] != SCFrameStatusComplete)
      return;
    CVPixelBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
    if (!buffer)
      return;
    size_t width = CVPixelBufferGetWidth(buffer),
           height = CVPixelBufferGetHeight(buffer);
    CGRect content = CGRectZero;
    if ([info[SCStreamFrameInfoContentRect] isKindOfClass:NSDictionary.class])
      CGRectMakeWithDictionaryRepresentation(
          (__bridge CFDictionaryRef)info[SCStreamFrameInfoContentRect],
          &content);
    double scale = [info[SCStreamFrameInfoScaleFactor] doubleValue];
    if (scale <= 0)
      scale = 1;
    CGRect crop = CGRectIntegral(
        CGRectMake(content.origin.x * scale, content.origin.y * scale,
                   content.size.width * scale, content.size.height * scale));
    CGRect full = CGRectMake(0, 0, width, height);
    if (CGRectIsEmpty(crop) || !CGRectContainsRect(full, crop)) {
      _failure =
          [NSError errorWithDomain:@"KCodeCUA"
                              code:1
                          userInfo:@{
                            NSLocalizedDescriptionKey :
                                @"Capture content geometry is unavailable"
                          }];
      _finished = YES;
      dispatch_semaphore_signal(_ready);
      return;
    }
    // 框架可复用 sample buffer。回调只复制像素，避免编码阻塞停止采集。
    CGImageRef raster = copyRaster(buffer, crop, &_blank);
    if (!raster)
      return;
    _raster = CFBridgingRelease(raster);
    _finished = YES;
    dispatch_semaphore_signal(_ready);
  }
}
@end
static NSString *displayTopology(void) {
  CGDirectDisplayID displays[32];
  uint32_t count = 0;
  if (CGGetActiveDisplayList(32, displays, &count) != kCGErrorSuccess)
    return nil;
  NSMutableArray *topology = [NSMutableArray array];
  for (uint32_t i = 0; i < count; i++) {
    CGRect b = CGDisplayBounds(displays[i]);
    [topology addObject:@[
      @(displays[i]), @(b.origin.x), @(b.origin.y), @(b.size.width),
      @(b.size.height), @(CGDisplayPixelsWide(displays[i])),
      @(CGDisplayPixelsHigh(displays[i]))
    ]];
  }
  return [[NSString alloc]
      initWithData:[NSJSONSerialization dataWithJSONObject:topology
                                                   options:0
                                                     error:nil]
          encoding:NSUTF8StringEncoding];
}
// 坐标派发前核对截图时记录的显示拓扑：与 capture 写进结果的 topology_fingerprint 是同一份。
NSString *KCUADisplayTopologyFingerprint(void) { return displayTopology(); }
// ScreenCaptureKit 的单帧请求没有取消 API，只有回调能确认框架工作已结束。
void KCUAWaitForCaptureCompletion(dispatch_semaphore_t ready,
                                  void (^check)(void)) {
  @try {
    while (dispatch_semaphore_wait(
               ready, dispatch_time(DISPATCH_TIME_NOW, 20000000)) != 0)
      check();
  } @catch (NSException *error) {
    if (dispatch_semaphore_wait(
            ready, dispatch_time(DISPATCH_TIME_NOW, 3000000000)) != 0)
      KCUAFail(@"cleanup_incomplete",
               @"ScreenCaptureKit did not finish after interruption");
    @throw;
  }
  check();
}

API_AVAILABLE(macos(14.0))
static id captureSingleFrame(SCContentFilter *filter,
                             SCStreamConfiguration *configuration,
                             void (^check)(void)) {
  dispatch_semaphore_t ready = dispatch_semaphore_create(0);
  __block id snapshot;
  __block NSError *failure;
  [SCScreenshotManager
      captureImageWithFilter:filter
               configuration:configuration
           completionHandler:^(CGImageRef image, NSError *error) {
             failure = error;
             if (image)
               snapshot = CFBridgingRelease(CGImageRetain(image));
             dispatch_semaphore_signal(ready);
           }];
  KCUAWaitForCaptureCompletion(ready, check);
  if (failure || !snapshot)
    KCUAFail(@"element_unavailable",
             @"ScreenCaptureKit returned no single-frame raster",
             failure
                 ? @{@"platform_error_code" : @(failure.code)}
                 : nil);
  return snapshot;
}

static bool rasterIsUniform(CGImageRef image) {
  uint8_t pixels[16 * 16 * 4] = {};
  CGColorSpaceRef colors = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(
      pixels, 16, 16, 8, 16 * 4, colors,
      kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
  CGColorSpaceRelease(colors);
  if (!context)
    KCUAFail(@"element_unavailable", @"Cannot inspect captured pixels");
  CGContextSetInterpolationQuality(context, kCGInterpolationNone);
  CGContextDrawImage(context, CGRectMake(0, 0, 16, 16), image);
  CGContextRelease(context);
  for (size_t i = 4; i < sizeof(pixels); i += 4)
    if (std::memcmp(pixels, pixels + i, 4) != 0)
      return false;
  return true;
}

static KCUAFrameOutput *
captureLegacyStream(SCContentFilter *filter,
                    SCStreamConfiguration *configuration, void (^check)(void)) {
  KCUAFrameOutput *output = [KCUAFrameOutput new];
  SCStream *stream = [[SCStream alloc] initWithFilter:filter
                                        configuration:configuration
                                             delegate:output];
  NSError *addError;
  if (![stream addStreamOutput:output
                          type:SCStreamOutputTypeScreen
            sampleHandlerQueue:dispatch_get_global_queue(
                                   QOS_CLASS_USER_INITIATED, 0)
                         error:&addError])
    KCUAFail(@"element_unavailable",
             @"Could not attach the ScreenCaptureKit frame output");
  dispatch_semaphore_t started = dispatch_semaphore_create(0);
  __block NSError *startError;
  [stream startCaptureWithCompletionHandler:^(NSError *error) {
    startError = error;
    dispatch_semaphore_signal(started);
  }];
  NSException *failure;
  @try {
    KCUAWaitForCaptureCompletion(started, check);
    if (startError)
      KCUAFail(
          @"element_unavailable", @"ScreenCaptureKit stream failed to start",
          @{@"platform_error_code" : @(startError.code)});
    while (dispatch_semaphore_wait(
               output.ready, dispatch_time(DISPATCH_TIME_NOW, 20000000)) != 0) {
      check();
    }
    if (output.failure || !output.raster)
      KCUAFail(@"element_unavailable",
               @"ScreenCaptureKit returned no usable pixels");
  } @catch (NSException *error) {
    if ([error.name isEqual:@"cleanup_incomplete"] || startError)
      @throw;
    failure = error;
  }
  // 失败或取消后拒绝晚到帧，停止确认仍由下面的 completion handler 提供。
  @synchronized(output) {
    output.finished = YES;
  }
  // 取消回执等待 stop 的真实完成；停止超时会阻止后续输入并交给原生恢复
  // watchdog。
  dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
  __block NSError *stopError;
  [stream stopCaptureWithCompletionHandler:^(NSError *error) {
    stopError = error;
    dispatch_semaphore_signal(stopped);
  }];
  if (dispatch_semaphore_wait(
          stopped, dispatch_time(DISPATCH_TIME_NOW, 3000000000)) != 0 ||
      stopError)
    KCUAFail(@"cleanup_incomplete",
             @"ScreenCaptureKit stream cleanup could not be confirmed",
             stopError
                 ? @{@"platform_error_code" : @(stopError.code)}
                 : nil);
  if (failure)
    @throw failure;
  return output;
}

NSDictionary *KCUACapture(const KCUATargetRef &target, const KCUAOp &op) {
  KCUACheck(op);
  KCUAValidateTarget(target);
  if (!CGPreflightScreenCaptureAccess())
    KCUAFail(@"permission_denied",
             @"Enable Screen Recording for KCode Computer Use");
  NSString *topology = displayTopology();
  if (!topology)
    KCUAFail(@"element_unavailable", @"Display topology is unavailable");
  dispatch_semaphore_t sharedReady = dispatch_semaphore_create(0);
  __block SCShareableContent *content;
  __block NSError *shareError;
  [SCShareableContent
      getShareableContentExcludingDesktopWindows:YES
                             onScreenWindowsOnly:NO
                               completionHandler:^(SCShareableContent *value,
                                                   NSError *error) {
                                 content = value;
                                 shareError = error;
                                 dispatch_semaphore_signal(sharedReady);
                               }];
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
  while (dispatch_semaphore_wait(
             sharedReady, dispatch_time(DISPATCH_TIME_NOW, 20000000)) != 0) {
    KCUACheck(op);
    if (std::chrono::steady_clock::now() >= deadline)
      KCUAFail(@"timeout",
               @"ScreenCaptureKit shareable-content deadline exceeded");
  }
  if (!content || shareError)
    KCUAFail(@"element_unavailable",
             @"ScreenCaptureKit cannot enumerate target windows");
  SCWindow *window;
  for (SCWindow *entry in content.windows)
    if (entry.windowID == target->windowId &&
        entry.owningApplication.processID == target->pid) {
      window = entry;
      break;
    }
  if (!window || !CGRectEqualToRect(window.frame, target->bounds))
    KCUAFail(@"element_unavailable",
             @"Target window changed during capture; observe again");
  double scale = 1;
  for (SCDisplay *display in content.displays)
    if (CGRectIntersectsRect(display.frame, window.frame)) {
      CGRect bounds = CGDisplayBounds(display.displayID);
      scale = bounds.size.width > 0
                  ? (double)CGDisplayPixelsWide(display.displayID) /
                        bounds.size.width
                  : 1;
      break;
    }
  NSUInteger width = (NSUInteger)ceil(window.frame.size.width * scale),
             height = (NSUInteger)ceil(window.frame.size.height * scale);
  if (!width || !height || width > 8192 || height > 8192 ||
      width * height > 16 * 1024 * 1024)
    KCUAFail(@"element_unavailable", @"Target raster exceeds capture limits");
  SCContentFilter *filter =
      [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
  SCStreamConfiguration *configuration = [SCStreamConfiguration new];
  configuration.width = width;
  configuration.height = height;
  configuration.pixelFormat = kCVPixelFormatType_32BGRA;
  configuration.showsCursor = NO;
  configuration.queueDepth = 1;
  configuration.scalesToFit = NO;
  configuration.capturesAudio = NO;
  if (@available(macOS 14.0, *)) {
    configuration.ignoreShadowsSingleWindow = YES;
    configuration.preservesAspectRatio = NO;
  }
  void (^checkpoint)(void) = ^{
    KCUACheck(op);
    if (std::chrono::steady_clock::now() >= deadline)
      KCUAFail(@"timeout", @"ScreenCaptureKit capture deadline exceeded");
  };
  void (^captureCheck)(void) = ^{
    checkpoint();
    KCUARequireDesktop();
  };
  captureCheck();
  id snapshot;
  bool blank;
  // M2 上短命 SCStream 收到 -3808 后析构仍在运行。单帧由系统持有结束时序，
  // 只在 macOS 13 保留需要自行等待 start/stop 的兼容路径。
  if (@available(macOS 14.0, *)) {
    snapshot = captureSingleFrame(filter, configuration, captureCheck);
    blank = rasterIsUniform((__bridge CGImageRef)snapshot);
  } else {
    KCUAFrameOutput *output =
        captureLegacyStream(filter, configuration, captureCheck);
    snapshot = output.raster;
    blank = output.blank;
  }
  checkpoint();
  KCUAValidateTarget(target);
  CGImageRef raster = (__bridge CGImageRef)snapshot;
  NSUInteger rasterWidth = CGImageGetWidth(raster),
             rasterHeight = CGImageGetHeight(raster);
  CGRect now = KCUAAXBounds(target->window);
  if (!CGRectEqualToRect(now, target->bounds) ||
      ![topology isEqual:displayTopology()] ||
      fabs((double)rasterWidth / scale - now.size.width) > 1 ||
      fabs((double)rasterHeight / scale - now.size.height) > 1)
    KCUAFail(@"element_unavailable",
             @"Captured raster geometry or display topology changed");
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:raster];
  NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG
                                     properties:@{}];
  NSDictionary *encoded =
      KCUAEncodeRaster(png, rasterWidth, rasterHeight, checkpoint);
  checkpoint();
  KCUAValidateTarget(target, true);
  if (![topology isEqual:displayTopology()])
    KCUAFail(@"element_unavailable",
             @"Display topology changed during encoding");
  NSDictionary *bounds = @{
    @"x" : @(now.origin.x),
    @"y" : @(now.origin.y),
    @"width" : @(now.size.width),
    @"height" : @(now.size.height),
    @"unit" : @"point"
  };
  return @{
    @"screenshot" : @{
      @"format" : encoded[@"format"],
      @"data" : [encoded[@"bytes"] base64EncodedStringWithOptions:0],
      @"width" : encoded[@"width"],
      @"height" : encoded[@"height"]
    },
    @"screenshot_blank" : @(blank),
    @"screenshot_bounds" : bounds,
    @"coordinate_contract" : @"frame_pixel_projection_v1",
    @"pointer" : bounds,
    @"display" : @{@"topology_fingerprint" : topology},
    @"surface_identity" : @{
      @"pid" : @(target->pid),
      @"process_birth" : target->birth,
      @"window_id" : @(target->windowId),
      @"helper_generation" : KCUAGeneration()
    }
  };
}
