#import "automation.h"
#import "raster-encoding.h"
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <chrono>
#include <cmath>

@interface KCUAFrameOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic) dispatch_semaphore_t ready;
@property(nonatomic, strong) NSData *png;
@property(nonatomic, strong) NSError *failure;
@property(nonatomic) NSUInteger width;
@property(nonatomic) NSUInteger height;
@property(nonatomic) BOOL finished;
@property(nonatomic) BOOL blank;
@property(nonatomic) CGRect contentRect;
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
    CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    size_t width = CVPixelBufferGetWidth(buffer),
           height = CVPixelBufferGetHeight(buffer);
    const uint8_t *pixels =
        (const uint8_t *)CVPixelBufferGetBaseAddress(buffer);
    size_t stride = CVPixelBufferGetBytesPerRow(buffer);
    bool uniform = true;
    for (size_t y = 0; y < height && uniform; y += MAX((size_t)1, height / 12))
      for (size_t x = 0; x < width; x += MAX((size_t)1, width / 12)) {
        const uint8_t *pixel = pixels + y * stride + x * 4;
        if (pixel[0] != pixels[0] || pixel[1] != pixels[1] ||
            pixel[2] != pixels[2]) {
          uniform = false;
          break;
        }
      }
    _blank = uniform;
    CGColorSpaceRef colors = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(
        CVPixelBufferGetBaseAddress(buffer), width, height, 8,
        CVPixelBufferGetBytesPerRow(buffer), colors,
        kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
    CGImageRef image = context ? CGBitmapContextCreateImage(context) : nullptr;
    if (context)
      CGContextRelease(context);
    CGColorSpaceRelease(colors);
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    if (!image)
      return;
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
    CGImageRef raster = nullptr;
    if (!CGRectIsEmpty(crop) && CGRectContainsRect(full, crop)) {
      raster = CGImageCreateWithImageInRect(image, crop);
      _contentRect = content;
    } else {
      CGImageRelease(image);
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
      _contentRect =
          CGRectMake(0, 0, (double)width / scale, (double)height / scale);
    }
    CGImageRelease(image);
    if (!raster)
      return;
    NSBitmapImageRep *bitmap =
        [[NSBitmapImageRep alloc] initWithCGImage:raster];
    _width = CGImageGetWidth(raster);
    _height = CGImageGetHeight(raster);
    _png = [bitmap representationUsingType:NSBitmapImageFileTypePNG
                                properties:@{}];
    CGImageRelease(raster);
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
  [stream startCaptureWithCompletionHandler:^(NSError *error) {
    if (error)
      [output stream:stream didStopWithError:error];
  }];
  NSException *failure;
  @try {
    while (dispatch_semaphore_wait(
               output.ready, dispatch_time(DISPATCH_TIME_NOW, 20000000)) != 0) {
      KCUACheck(op);
      KCUARequireDesktop();
      if (std::chrono::steady_clock::now() >= deadline)
        KCUAFail(@"timeout", @"ScreenCaptureKit frame deadline exceeded");
    }
    if (output.failure || !output.png.length)
      KCUAFail(@"element_unavailable",
               @"ScreenCaptureKit returned no usable pixels");
  } @catch (NSException *error) {
    failure = error;
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
             @"ScreenCaptureKit stream cleanup could not be confirmed");
  @synchronized(output) {
    output.finished = YES;
  }
  if (failure)
    @throw failure;
  KCUACheck(op);
  KCUAValidateTarget(target);
  CGRect now = KCUAAXBounds(target->window);
  if (!CGRectEqualToRect(now, target->bounds) ||
      ![topology isEqual:displayTopology()] ||
      fabs((double)output.width / scale - now.size.width) > 1 ||
      fabs((double)output.height / scale - now.size.height) > 1)
    KCUAFail(@"element_unavailable",
             @"Captured raster geometry or display topology changed");
  NSDictionary *encoded =
      KCUAEncodeRaster(output.png, output.width, output.height);
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
    @"screenshot_blank" : @(output.blank),
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
