#import "protocol.h"
id KCUADispatch(NSString *method, NSDictionary *params, const KCUAOp &op) {
  (void)params; KCUACheck(op);
  if ([method isEqual:@"controller_takeover"]) { KCUAAcquireLease(); return KCUALeaseStatus(); }
  if ([method isEqual:@"controller_stop"]) { KCUAReleaseLease(); return @{@"stopped": @YES}; }
  KCUAFail(@"method_not_found", [NSString stringWithFormat:@"Unsupported CUA broker method: %@", method]);
}
void KCUACleanup(const KCUAOp &op) { (void)op; }
