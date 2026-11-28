#import <Foundation/Foundation.h>
#include <sys/types.h>
NSString *KCUADesktopAvailabilityFromFacts(NSDictionary *session,
                                           NSArray *users, id rootLocked,
                                           uid_t uid) {
  id sessionLocked = session[@"CGSSessionScreenIsLocked"];
  if ([sessionLocked isKindOfClass:NSNumber.class] && [sessionLocked boolValue])
    return @"locked";
  // M2 macOS27 的锁定标志位于 registry root.IOConsoleLocked，而非用户记录。
  // 只结合同 UID 的真实 console owner 采信它，SSH 本身不是解锁证明。
  for (NSDictionary *user in [users isKindOfClass:NSArray.class] ? users
                                                                 : @[]) {
    if (![user isKindOfClass:NSDictionary.class] ||
        ![user[@"kCGSSessionUserIDKey"] isKindOfClass:NSNumber.class] ||
        [user[@"kCGSSessionUserIDKey"] unsignedIntValue] != uid ||
        ![user[@"kCGSSessionOnConsoleKey"] boolValue])
      continue;
    if ([rootLocked isKindOfClass:NSNumber.class])
      return [rootLocked boolValue] ? @"locked" : @"unlocked";
  }
  if ([sessionLocked isKindOfClass:NSNumber.class] &&
      [session[@"kCGSSessionOnConsoleKey"] boolValue] &&
      [session[@"kCGSSessionLoginDoneKey"] boolValue])
    return [sessionLocked boolValue] ? @"locked" : @"unlocked";
  return @"unknown";
}
