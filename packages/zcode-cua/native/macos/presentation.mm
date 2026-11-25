#import "automation.h"
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <cmath>
#include <deque>
#include <map>
#include <set>

static NSPanel *pipPanel;
static NSImageView *pipImage;
static NSPanel *ghostPanel;
static std::atomic<bool> pipEnabled{false};
// ghost cursor 与 PiP 是两个独立的进程级开关：设置页的只读探测只传 --ghost-cursor-overlay，
// 之后被复用的常驻 Helper 仍要给真实输入画光标。
static std::atomic<bool> ghostCursorEnabled{false};
static std::atomic<bool> pipDismissed{false};
static std::atomic<uint64_t> visualGeneration{0};
static std::recursive_mutex liveLifecycleMutex;
static std::atomic<bool> framePending{false};
static std::atomic<bool> presentationSuspended{false};
static void stopLive(void);
static SCStream *pipStream;
static id pipOutput;
static NSString *activeSession;
static NSInteger focusRevision = -1;
static NSMutableDictionary<NSString *, NSString *> *turns;
static NSMutableDictionary<NSString *, NSNumber *> *sequences;
static NSMutableSet<NSString *> *eventIds;
static NSMutableArray<NSString *> *eventOrder;
static NSMutableDictionary<NSString *, NSDictionary *> *targets;
static std::mutex presentationMutex;

@interface KCUALivePresentation : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic) uint64_t generation;
@end
@implementation KCUALivePresentation
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  (void)stream;
  (void)error;
}
- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
  (void)stream;
  if (presentationSuspended || ![KCUADesktopAvailability() isEqual:@"unlocked"])
    return;
  if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample))
    return;
  if (framePending.exchange(true))
    return;
  CVPixelBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
  if (!buffer) {
    framePending = false;
    return;
  }
  CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef bitmap = CGBitmapContextCreate(
      CVPixelBufferGetBaseAddress(buffer), CVPixelBufferGetWidth(buffer),
      CVPixelBufferGetHeight(buffer), 8, CVPixelBufferGetBytesPerRow(buffer),
      space, kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
  CGImageRef image = bitmap ? CGBitmapContextCreateImage(bitmap) : nullptr;
  if (bitmap)
    CGContextRelease(bitmap);
  CGColorSpaceRelease(space);
  CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
  if (!image) {
    framePending = false;
    return;
  }
  NSImage *preview = [[NSImage alloc] initWithCGImage:image size:NSZeroSize];
  CGImageRelease(image);
  uint64_t generation = self.generation;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (generation == visualGeneration && pipPanel && !pipDismissed &&
        !presentationSuspended) {
      pipImage.image = preview;
      if (!pipPanel.visible)
        [pipPanel orderFrontRegardless];
    }
    framePending = false;
  });
}
@end
@interface KCUAPipDelegate : NSObject <NSWindowDelegate>
@end
@implementation KCUAPipDelegate
- (void)windowWillClose:(NSNotification *)note {
  (void)note;
  pipDismissed = true;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    @try {
      stopLive();
    } @catch (NSException *error) {
      (void)error;
    }
  });
}
@end
static KCUAPipDelegate *pipDelegate;
static void mainSync(dispatch_block_t block) {
  if (NSThread.isMainThread)
    block();
  else
    dispatch_sync(dispatch_get_main_queue(), block);
}
static void createPip(void) {
  if (pipPanel)
    return;
  NSRect screen = NSScreen.mainScreen.visibleFrame;
  pipPanel = [[NSPanel alloc]
      initWithContentRect:NSMakeRect(NSMaxX(screen) - 380, NSMinY(screen) + 36,
                                     350, 230)
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                          NSWindowStyleMaskNonactivatingPanel
                  backing:NSBackingStoreBuffered
                    defer:NO];
  pipPanel.title = @"KCode · 电脑操作";
  pipPanel.level = NSFloatingWindowLevel;
  pipPanel.hidesOnDeactivate = NO;
  pipPanel.releasedWhenClosed = NO;
  pipPanel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                NSWindowCollectionBehaviorFullScreenAuxiliary;
  pipImage = [[NSImageView alloc] initWithFrame:pipPanel.contentView.bounds];
  pipImage.imageScaling = NSImageScaleProportionallyUpOrDown;
  pipImage.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [pipPanel.contentView addSubview:pipImage];
  pipDelegate = [KCUAPipDelegate new];
  pipPanel.delegate = pipDelegate;
}
static void stopLive(void) {
  std::lock_guard<std::recursive_mutex> guard(liveLifecycleMutex);
  SCStream *old;
  mainSync(^{
    visualGeneration++;
    [pipPanel orderOut:nil];
  });
  {
    std::lock_guard<std::mutex> lock(presentationMutex);
    old = pipStream;
    pipStream = nil;
    pipOutput = nil;
  }
  if (old) {
    dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
    [old stopCaptureWithCompletionHandler:^(NSError *error) {
      (void)error;
      dispatch_semaphore_signal(stopped);
    }];
    if (dispatch_semaphore_wait(
            stopped, dispatch_time(DISPATCH_TIME_NOW, 3000000000)) != 0)
      KCUAFail(@"cleanup_incomplete", @"PiP capture stream did not drain");
  }
}
static void startLive(NSDictionary *target) {
  std::lock_guard<std::recursive_mutex> guard(liveLifecycleMutex);
  if (!pipEnabled || pipDismissed)
    return;
  stopLive();
  __block uint64_t generation;
  mainSync(^{
    createPip();
    generation = visualGeneration;
  });
  [SCShareableContent
      getShareableContentExcludingDesktopWindows:YES
                             onScreenWindowsOnly:NO
                               completionHandler:^(SCShareableContent *content,
                                                   NSError *error) {
                                 if (error)
                                   return;
                                 SCWindow *selected;
                                 for (SCWindow *window in content.windows)
                                   if (window.windowID ==
                                           [target[@"windowId"]
                                               unsignedIntValue] &&
                                       window.owningApplication.processID ==
                                           [target[@"pid"] intValue]) {
                                     selected = window;
                                     break;
                                   }
                                 if (!selected)
                                   return;
                                 SCContentFilter *filter = [[SCContentFilter
                                     alloc]
                                     initWithDesktopIndependentWindow:selected];
                                 SCStreamConfiguration *config =
                                     [SCStreamConfiguration new];
                                 config.width = 700;
                                 config.height = (NSUInteger)MAX(
                                     1,
                                     round(700 * selected.frame.size.height /
                                           MAX(1, selected.frame.size.width)));
                                 config.showsCursor = NO;
                                 config.queueDepth = 1;
                                 config.minimumFrameInterval =
                                     CMTimeMake(1, 10);
                                 config.pixelFormat = kCVPixelFormatType_32BGRA;
                                 if (@available(macOS 14.0, *))
                                   config.ignoreShadowsSingleWindow = YES;
                                 KCUALivePresentation *output =
                                     [KCUALivePresentation new];
                                 output.generation = generation;
                                 SCStream *stream =
                                     [[SCStream alloc] initWithFilter:filter
                                                        configuration:config
                                                             delegate:output];
                                 if (![stream
                                            addStreamOutput:output
                                                       type:
                                                           SCStreamOutputTypeScreen
                                         sampleHandlerQueue:
                                             dispatch_get_global_queue(
                                                 QOS_CLASS_UTILITY, 0)
                                                      error:nil])
                                   return;
                                 {
                                   std::lock_guard<std::mutex> lock(
                                       presentationMutex);
                                   if (generation != visualGeneration)
                                     return;
                                   pipStream = stream;
                                   pipOutput = output;
                                 }
                                 [stream startCaptureWithCompletionHandler:^(
                                             NSError *failure) {
                                   if (failure)
                                     [stream stopCaptureWithCompletionHandler:^(
                                                 NSError *ignored) {
                                       (void)ignored;
                                     }];
                                 }];
                               }];
}
void KCUAPresentationInitialize(bool pip, bool ghostCursor) {
  pipEnabled = pip;
  ghostCursorEnabled = ghostCursor;
  turns = [NSMutableDictionary dictionary];
  sequences = [NSMutableDictionary dictionary];
  eventIds = [NSMutableSet set];
  eventOrder = [NSMutableArray array];
  targets = [NSMutableDictionary dictionary];
}
void KCUAPresentationCapture(const KCUATargetRef &target,
                             NSDictionary *context) {
  if (![KCUALeaseStatus()[@"is_owner"] boolValue])
    return;
  presentationSuspended = false;
  if (!pipEnabled || ![context[@"session_id"] isKindOfClass:NSString.class] ||
      ![context[@"turn_id"] isKindOfClass:NSString.class])
    return;
  NSString *session = context[@"session_id"], *turn = context[@"turn_id"];
  NSDictionary *value = @{
    @"pid" : @(target->pid),
    @"windowId" : @(target->windowId),
    @"birth" : target->birth,
    @"turnId" : turn
  };
  targets[session] = value;
  if ([activeSession isEqual:session] && [turns[session] isEqual:turn])
    startLive(value);
}
void KCUAGhostPoint(CGPoint point) {
  // 修复原因：ghost cursor 原先跟着 --pip-mode 一起开关，入口根本不读 --ghost-cursor-overlay。
  // 设置页先拉起 Helper 时不带 PiP，之后整轮真实输入都没有光标反馈。
  if (!ghostCursorEnabled)
    return;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!ghostPanel) {
      ghostPanel = [[NSPanel alloc]
          initWithContentRect:NSMakeRect(0, 0, 24, 28)
                    styleMask:NSWindowStyleMaskBorderless |
                              NSWindowStyleMaskNonactivatingPanel
                      backing:NSBackingStoreBuffered
                        defer:NO];
      ghostPanel.opaque = NO;
      ghostPanel.backgroundColor = NSColor.clearColor;
      ghostPanel.ignoresMouseEvents = YES;
      ghostPanel.level = NSStatusWindowLevel;
      ghostPanel.collectionBehavior =
          NSWindowCollectionBehaviorCanJoinAllSpaces |
          NSWindowCollectionBehaviorFullScreenAuxiliary;
      NSImageView *cursor =
          [[NSImageView alloc] initWithFrame:NSMakeRect(0, 0, 24, 28)];
      cursor.image = [NSImage imageWithSystemSymbolName:@"cursorarrow"
                               accessibilityDescription:nil];
      cursor.contentTintColor = NSColor.controlAccentColor;
      cursor.imageScaling = NSImageScaleProportionallyUpOrDown;
      [ghostPanel.contentView addSubview:cursor];
    }
    NSScreen *primary = NSScreen.screens.firstObject;
    double y = NSMaxY(primary.frame) - point.y;
    [ghostPanel setFrameOrigin:NSMakePoint(point.x, y - 28)];
    [ghostPanel orderFrontRegardless];
  });
}
void KCUAGhostHide(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [ghostPanel orderOut:nil];
  });
}
id KCUAPresentation(NSString *method, NSDictionary *params, const KCUAOp &op) {
  (void)op;
  if ([method isEqual:@"pip_session_handshake"]) {
    if (!pipEnabled || [params[@"protocolVersion"] intValue] != 2 ||
        ![params[@"runtimeId"] isEqual:@"zcode-cua-pip-session-v2"])
      KCUAFail(@"version_mismatch",
               @"PiP session protocol or capability mismatch");
    return @{
      @"ready" : @YES,
      @"protocolVersion" : @2,
      @"runtimeId" : @"zcode-cua-pip-session-v2"
    };
  }
  if ([method isEqual:@"pip_clear_dismissed"]) {
    mainSync(^{
      pipDismissed = false;
    });
    return @YES;
  }
  if ([method isEqual:@"pip_is_running"]) {
    __block bool visible = false;
    mainSync(^{
      visible = pipPanel.visible;
    });
    return @(visible);
  }
  if ([method isEqual:@"pip_stop"]) {
    stopLive();
    return @YES;
  }
  if ([method isEqual:@"pip_start"]) {
    KCUARequireDesktop();
    if (!pipEnabled)
      KCUAFail(@"action_unavailable", @"PiP is disabled");
    auto target = KCUAResolveTarget(
        params[@"app_ref"] ?: @{
          @"pid" : params[@"pid"] ?: @0,
          @"window_id" : params[@"window_id"] ?: @0
        },
        op, false);
    startLive(@{@"pid" : @(target->pid), @"windowId" : @(target->windowId)});
    return @YES;
  }
  if (![method isEqual:@"pip_session_event"])
    KCUAFail(@"method_not_found", @"Unknown presentation method");
  NSDictionary *event = params[@"event"];
  if (![event isKindOfClass:NSDictionary.class])
    KCUAFail(@"invalid_request", @"PiP event object required");
  NSString *kind = event[@"kind"], *session = event[@"sessionId"],
           *turn = event[@"turnId"], *eventId = event[@"eventId"];
  if ([kind isEqual:@"focus-changed"]) {
    NSInteger revision = [event[@"revision"] integerValue];
    if (revision <= focusRevision)
      return @{@"applied" : @NO, @"reason" : @"stale_revision"};
    focusRevision = revision;
    activeSession = [session isKindOfClass:NSString.class] ? session : nil;
    stopLive();
    NSDictionary *target = activeSession ? targets[activeSession] : nil;
    if (target && [turns[activeSession] isEqual:target[@"turnId"]])
      startLive(target);
    return @{@"applied" : @YES};
  }
  if (![session isKindOfClass:NSString.class] || !session.length ||
      ![eventId isKindOfClass:NSString.class] || !eventId.length ||
      ![event[@"sequenceNumber"] isKindOfClass:NSNumber.class])
    KCUAFail(@"invalid_request",
             @"PiP lifecycle requires session, eventId and sequenceNumber");
  if ([eventIds containsObject:eventId])
    return @{@"applied" : @NO, @"reason" : @"duplicate"};
  NSInteger sequence = [event[@"sequenceNumber"] integerValue];
  if (sequences[session] && sequence <= [sequences[session] integerValue])
    return @{@"applied" : @NO, @"reason" : @"stale_sequence"};
  [eventIds addObject:eventId];
  [eventOrder addObject:eventId];
  if (eventOrder.count > 4096) {
    [eventIds removeObject:eventOrder.firstObject];
    [eventOrder removeObjectAtIndex:0];
  }
  sequences[session] = @(sequence);
  if ([kind isEqual:@"turn-started"]) {
    if (![turn isKindOfClass:NSString.class] || !turn.length)
      KCUAFail(@"invalid_request", @"turn-started requires turnId");
    turns[session] = turn;
    mainSync(^{
      pipDismissed = false;
    });
    NSDictionary *target = targets[session];
    if ([activeSession isEqual:session] && [target[@"turnId"] isEqual:turn])
      startLive(target);
  } else if ([kind isEqual:@"turn-ended"] || [kind isEqual:@"session-closed"]) {
    if (!turn || [turns[session] isEqual:turn]) {
      [turns removeObjectForKey:session];
      [targets removeObjectForKey:session];
      if ([activeSession isEqual:session]) {
        stopLive();
        KCUAGhostHide();
      }
    }
  } else
    KCUAFail(@"invalid_request", @"Unsupported PiP lifecycle kind");
  return @{@"applied" : @YES};
}

void KCUASuspendPresentationForDesktop(void) {
  presentationSuspended = true;
  dispatch_async(dispatch_get_main_queue(), ^{
    [pipPanel orderOut:nil];
    [ghostPanel orderOut:nil];
  });
}
