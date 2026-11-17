#import "protocol.h"
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/IOKitLib.h>
#include <chrono>
#include <thread>

NSString *KCUADesktopAvailability(void) {
  NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
  if (!session)
    return @"unknown";
  if ([session[@"CGSSessionScreenIsLocked"] boolValue])
    return @"locked";
  if (![session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue] ||
      ![session[(__bridge NSString *)kCGSessionLoginDoneKey] boolValue])
    return @"unknown";
  // 锁屏状态在部分系统只发布在
  // IOConsoleUsers；缺失事实时不把后台进程当成解锁证明。
  io_registry_entry_t root = IORegistryGetRootEntry(kIOMainPortDefault);
  CFTypeRef usersRef =
      root ? IORegistryEntryCreateCFProperty(root, CFSTR("IOConsoleUsers"),
                                             kCFAllocatorDefault, 0)
           : nullptr;
  if (root)
    IOObjectRelease(root);
  NSArray *users = CFBridgingRelease(usersRef);
  for (NSDictionary *user in [users isKindOfClass:NSArray.class] ? users
                                                                 : @[]) {
    if ([user[@"kCGSSessionUserIDKey"] unsignedIntValue] != getuid())
      continue;
    id locked = user[@"CGSSessionScreenIsLocked"];
    if ([locked isKindOfClass:NSNumber.class])
      return [locked boolValue] ? @"locked" : @"unlocked";
  }
  if (session[@"CGSSessionScreenIsLocked"] != nil)
    return @"unlocked";
  return @"unknown";
}
void KCUARequireDesktop(void) {
  NSString *availability = KCUADesktopAvailability();
  if (![availability isEqual:@"unlocked"])
    KCUAFail(
        [availability isEqual:@"locked"] ? @"desktop_locked"
                                         : @"desktop_unavailable",
        @"Desktop is locked or its availability cannot be verified; unlock "
        @"manually and observe again",
        @{@"action_sent" : @NO,
          @"dispatch_status" : @"not_sent"});
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
    while (!availabilityStopping) {
      @autoreleasepool {
        observeAvailability(KCUADesktopAvailability());
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
