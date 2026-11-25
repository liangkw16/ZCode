#import "protocol.h"
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/IOKitLib.h>
#include <chrono>
#include <thread>

extern NSString *KCUADesktopAvailabilityFromFacts(NSDictionary *, NSArray *, id,
                                                  uid_t);
NSString *KCUADesktopAvailability(void) {
  NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
  io_registry_entry_t root = IORegistryGetRootEntry(kIOMainPortDefault);
  id users = root ? CFBridgingRelease(IORegistryEntryCreateCFProperty(
                        root, CFSTR("IOConsoleUsers"), kCFAllocatorDefault, 0))
                  : nil;
  id locked = root
                  ? CFBridgingRelease(IORegistryEntryCreateCFProperty(
                        root, CFSTR("IOConsoleLocked"), kCFAllocatorDefault, 0))
                  : nil;
  if (root)
    IOObjectRelease(root);
  return KCUADesktopAvailabilityFromFacts(session, users, locked, getuid());
}
NSDictionary *KCUADesktopAdmissionError(NSString *availability) {
  if ([availability isEqual:@"unlocked"])
    return nil;
  // 修复原因：锁屏原先返回自造的 desktop_locked，脱离了既有的 permission_denied /
  // reason:screen_locked / action_sent:false 错误形状（规范 §8.2 与 SDK 迁移说明）。
  // 锁定状态无法确定时同样拒绝，并明确说明原因；typed 的 availability 一并带出。
  BOOL locked = [availability isEqual:@"locked"];
  return KCUAError(
      @"permission_denied",
      locked
          ? @"The desktop is locked; unlock it and observe again"
          : @"Desktop availability is unknown; unlock state could not be verified",
      @{@"action_sent" : @NO,
        @"dispatch_status" : @"not_sent",
        @"reason" : locked ? @"screen_locked" : @"desktop_state_unknown",
        @"desktop_availability" : availability});
}
void KCUARequireDesktop(void) {
  NSDictionary *error = KCUADesktopAdmissionError(KCUADesktopAvailability());
  if (error)
    KCUAFail(error[@"error"][@"code"], error[@"error"][@"message"],
             error[@"error"][@"details"]);
}
NSDictionary *KCUAPermissionStatus(void) {
  NSString *ax = AXIsProcessTrusted() ? @"granted" : @"denied";
  NSString *screen = CGPreflightScreenCaptureAccess() ? @"granted" : @"denied";
  return @{
    @"grant_owner" : @"dev.zcode.cua-helper.kcode",
    @"owner" : @{@"display_name" : @"KCode Computer Use"},
    @"accessibility" : ax,
    @"screen_recording" : screen,
    @"desktop_availability" : KCUADesktopAvailability(),
    @"prompted" : @NO,
    @"capture_probe_ran" : @NO,
    @"accessibility_probe" : @{@"ok" : @NO, @"classification" : @"not_run"},
    @"screen_capture_probe" : @{@"ok" : @NO, @"classification" : @"not_run"}
  };
}
void KCUARequireAccessibility(void) {
  KCUARequireDesktop();
  if (!AXIsProcessTrusted())
    KCUAFail(
        @"permission_denied",
        @"Enable Accessibility for KCode Computer Use in System Settings",
        @{@"action_sent" : @NO,
          @"dispatch_status" : @"not_sent"});
}

static std::mutex availabilityMutex;
static NSString *lastAvailability;
static std::atomic<bool> availabilityStopping{false};
static std::thread availabilityThread;
static id lockObserver;
static void observeAvailability(NSString *state) {
  bool unavailable = false;
  {
    std::lock_guard<std::mutex> lock(availabilityMutex);
    if ([lastAvailability isEqual:state])
      return;
    unavailable =
        [lastAvailability isEqual:@"unlocked"] && ![state isEqual:@"unlocked"];
    lastAvailability = state;
  }
  if (unavailable)
    KCUANotifyDesktopUnavailable();
  if (![state isEqual:@"unlocked"])
    KCUASuspendPresentationForDesktop();
}
void KCUAStartAvailabilityTracking(void) {
  observeAvailability(KCUADesktopAvailability());
  lockObserver = [[NSDistributedNotificationCenter defaultCenter]
      addObserverForName:@"com.apple.screenIsLocked"
                  object:nil
                   queue:NSOperationQueue.mainQueue
              usingBlock:^(NSNotification *notification) {
                (void)notification;
                observeAvailability(@"locked");
              }];
  availabilityThread = std::thread([] {
    unsigned tick = 0;
    while (!availabilityStopping) {
      @autoreleasepool {
        // 修复原因：这个线程没有请求级的 @try，回收时读到坏 lease 抛出的异常会直接终止
        // 常驻 Helper。后台扫描的读取失败只跳过这一轮，下一轮再试。
        @try {
          observeAvailability(KCUADesktopAvailability());
          if (++tick % 20 == 0)
            KCUAReapDeadScopes();
        } @catch (NSException *error) {
          fprintf(stderr, "CUA background scan skipped: %s\n",
                  error.reason.UTF8String);
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
  });
}
void KCUAStopAvailabilityTracking(void) {
  availabilityStopping = true;
  if (availabilityThread.joinable())
    availabilityThread.join();
  if (lockObserver)
    [[NSDistributedNotificationCenter defaultCenter]
        removeObserver:lockObserver];
  lockObserver = nil;
}
