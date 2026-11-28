#import "protocol.h"
NSDictionary *KCUAOK(id result) {
  return @{@"ok" : @YES, @"result" : result ?: [NSNull null]};
}
NSDictionary *KCUAError(NSString *code, NSString *message,
                        NSDictionary *details) {
  NSMutableDictionary *error =
      [@{@"code" : code, @"message" : message} mutableCopy];
  if (details.count)
    error[@"details"] = details;
  return @{@"ok" : @NO, @"error" : error};
}
[[noreturn]] void KCUAFail(NSString *code, NSString *message,
                           NSDictionary *details) {
  @throw [NSException exceptionWithName:code reason:message userInfo:details];
}
