import {
  ZCODE_AGENT_PROVIDER,
  ZCODE_COMMAND_AGENT_SOURCES,
  ZCODE_DATA_DIR_SEGMENT,
  type ZCodeProvider,
  type CommandAgentSource,
} from "@zcode/shared";

export const COMMAND_AGENT_SOURCES = [
  ...ZCODE_COMMAND_AGENT_SOURCES,
] as const satisfies readonly CommandAgentSource[];

export const COMMAND_AGENT_SOURCE_META: Record<
  CommandAgentSource,
  {
    labelId: string;
    provider: ZCodeProvider;
    pathHint: string;
  }
> = {
  zcodeAgent: {
    labelId: "settings.commands.source.zcodeAgent",
    // 修复原因：提示路径原先写死 "~/.zcode"，与 agent 实际读取的用户级目录（随产品 segment）不一致。
    pathHint: `~/${ZCODE_DATA_DIR_SEGMENT}/commands`,
    provider: ZCODE_AGENT_PROVIDER,
  },
};
