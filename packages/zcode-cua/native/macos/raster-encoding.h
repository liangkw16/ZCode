#pragma once
#import <Cocoa/Cocoa.h>
NSDictionary *KCUAEncodeRaster(NSData *png, NSUInteger width, NSUInteger height,
                               void (^checkpoint)(void) = nil);
