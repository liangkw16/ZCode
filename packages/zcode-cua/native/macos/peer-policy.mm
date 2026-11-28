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
  // AppKit 和 proc_pidpath 对 /tmp 等别名的表示可能不同，包含关系必须在同一解析规则下检查。
  NSString *prefix = [mainAppPath.stringByResolvingSymlinksInPath
      stringByAppendingString:@"/Contents/"];
  return [peerPath.stringByResolvingSymlinksInPath hasPrefix:prefix];
}
