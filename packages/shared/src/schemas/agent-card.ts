import { z } from "zod";

export const agentSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  examples: z.array(z.string()).default([]),
});

export type AgentSkill = z.infer<typeof agentSkillSchema>;

export const agentCardSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  url: z.string().url(),
  capabilities: z.object({
    streaming: z.boolean().default(false),
    pushNotifications: z.boolean().default(false),
  }),
  skills: z.array(agentSkillSchema).min(1),
  defaultInputModes: z.array(z.string()).default(["application/json"]),
  defaultOutputModes: z.array(z.string()).default(["application/json"]),
});

export type AgentCard = z.infer<typeof agentCardSchema>;

export interface CreateAgentCardInput {
  name: string;
  description: string;
  version?: string;
  baseUrl: string;
  skills: AgentSkill[];
}

export function createAgentCard(input: CreateAgentCardInput): AgentCard {
  return {
    name: input.name,
    description: input.description,
    version: input.version ?? "0.1.0",
    url: input.baseUrl,
    capabilities: { streaming: false, pushNotifications: false },
    skills: input.skills,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
  };
}
