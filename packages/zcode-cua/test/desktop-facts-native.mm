#import <Foundation/Foundation.h>
#include <sys/types.h>
extern NSString *KCUADesktopAvailabilityFromFacts(NSDictionary *, NSArray *, id,
                                                  uid_t);
int main() {
  @autoreleasepool {
    NSArray *users = @[
      @{@"kCGSSessionUserIDKey" : @501,
        @"kCGSSessionOnConsoleKey" : @YES}
    ];
    // M2 macOS27 实测：锁定事实在 root.IOConsoleLocked，IOConsoleUsers 没有
    // ScreenIsLocked 字段。
    NSCAssert(
        [KCUADesktopAvailabilityFromFacts(nil, users, @NO, 501)
            isEqual:@"unlocked"],
        @"Root unlocked fact with exact console owner must work over SSH");
    NSCAssert([KCUADesktopAvailabilityFromFacts(nil, users, @YES, 501)
                  isEqual:@"locked"],
              @"Root lock fact must reject input");
    NSCAssert([KCUADesktopAvailabilityFromFacts(nil, users, @NO, 502)
                  isEqual:@"unknown"],
              @"Another console user is not an unlock proof");
    NSCAssert([KCUADesktopAvailabilityFromFacts(nil, users, nil, 501)
                  isEqual:@"unknown"],
              @"Missing lock fact fails closed");
    NSCAssert([KCUADesktopAvailabilityFromFacts(
                  @{@"CGSSessionScreenIsLocked" : @YES}, users, @NO, 501)
                  isEqual:@"locked"],
              @"Any explicit locked fact wins");
    puts("desktop OS fact regressions passed");
  }
}
