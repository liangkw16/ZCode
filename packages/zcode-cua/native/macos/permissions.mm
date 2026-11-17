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
    unsigned tick = 0;
    while (!availabilityStopping) {
      @autoreleasepool {
        observeAvailability(KCUADesktopAvailability());
        if (++tick % 20 == 0)
          KCUAReapDeadScopes();
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
