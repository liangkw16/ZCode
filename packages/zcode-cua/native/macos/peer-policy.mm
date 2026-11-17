#import <Foundation/Foundation.h>
bool KCUATrustedProductPeer(NSData *ownLeaf, NSData *peerLeaf,
                            NSString *identifier, NSString *peerPath,
                            NSString *mainAppPath, bool verifiedMainLineage) {
  if (!ownLeaf.length || !peerLeaf.length || ![ownLeaf isEqual:peerLeaf] ||
      !verifiedMainLineage || !mainAppPath.length)
    return false;
  if (![@[ @"dev.zcode.app.kcode", @"dev.zcode.app.kcode.helper" ]
          containsObject:identifier])
    return false;
  NSString *prefix = [mainAppPath stringByAppendingString:@"/Contents/"];
  return [peerPath hasPrefix:prefix];
}
