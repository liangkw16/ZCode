# KCode CUA module

Public ownership, sequencing and cross-module boundaries are defined in [the package contract](../CONTRACT.md). The Host owns logical model state; the Cocoa Helper owns native operations and cleanup. IO adapters may implement contract ports; pure domain code never imports platform IO. Model workers receive neither socket paths nor native capabilities.
