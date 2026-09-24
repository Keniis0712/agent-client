import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

type Json = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: Json };

const baseUrl = (process.env.APC_BASE_URL ?? "http://127.0.0.1:8765").replace(/\/$/, "");
const role = process.env.APC_AGENT_ROLE === "orchestrator" ? "orchestrator" : "project";
const mainSessionId = process.env.APC_MAIN_SESSION_ID ?? "";
const projectId = process.env.APC_PROJECT_ID ?? "";
const projectRunId = process.env.APC_PROJECT_RUN_ID ?? "";

const objectSchema = (properties: Json = {}, required: string[] = []): Json => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const ORCHESTRATOR_TOOLS: Tool[] = [
  { name: "list_projects", description: "List all projects in the portfolio, including status, priority, schedule and execution metadata.", inputSchema: objectSchema() },
  { name: "get_project_portfolio", description: "Read the project portfolio overview and pipeline groups before making cross-project scheduling decisions.", inputSchema: objectSchema() },
  { name: "get_project", description: "Read one project's metadata, status and schedule.", inputSchema: objectSchema({ project_id: { type: "string" } }, ["project_id"]) },
  {
    name: "create_project",
    description: "Create a project in the Console portfolio. This manages portfolio metadata only; project planning and implementation belong to its project agent.",
    inputSchema: objectSchema({
      name: { type: "string" },
      description: { type: "string" },
      local_path: { type: "string" },
      repo_url: { type: "string" },
      default_branch: { type: "string" },
      status: { enum: ["planning", "backlog", "scheduled", "active", "paused", "blocked", "review", "completed", "done", "archived"] },
      priority: { enum: ["low", "medium", "high", "critical"] },
      size: { enum: ["", "S", "M", "L"] },
      theme: { type: "string" },
      planned_start_at: { type: "string", description: "ISO 8601 date/time. Omit when the project is not scheduled." },
      planned_duration_days: { type: "integer", minimum: 0, maximum: 3650 },
    }, ["name"]),
  },
  {
    name: "update_project",
    description: "Update project portfolio metadata, including name, status, priority, size, start date and duration. Use status=archived instead of deleting a project.",
    inputSchema: objectSchema({
      project_id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      local_path: { type: "string" },
      repo_url: { type: "string" },
      default_branch: { type: "string" },
      status: { enum: ["planning", "backlog", "scheduled", "active", "paused", "blocked", "review", "completed", "done", "archived"] },
      priority: { enum: ["low", "medium", "high", "critical"] },
      size: { enum: ["", "S", "M", "L"] },
      theme: { type: "string" },
      planned_start_at: { type: ["string", "null"], description: "ISO 8601 date/time. Use null or an empty string to remove the project from the schedule." },
      planned_duration_days: { type: "integer", minimum: 0, maximum: 3650 },
      reason: { type: "string" },
    }, ["project_id", "reason"]),
  },
  { name: "list_execution_targets", description: "List online target devices and the Claude agent platform available on each device.", inputSchema: objectSchema() },
  { name: "list_runtime_profiles", description: "List Console-owned runtime profiles without exposing their API keys.", inputSchema: objectSchema() },
  { name: "list_project_agents", description: "List project agent runs managed by this main agent.", inputSchema: objectSchema() },
  { name: "start_project_agent", description: "Start a Claude project agent on a device. The Console resolves the project's execution directory from its local path.", inputSchema: objectSchema({ project_id: { type: "string" }, client_id: { type: "string" }, device_id: { type: "string" }, agent: { enum: ["claude"] }, message: { type: "string" }, runtime_profile_id: { type: "string" }, permission_policy: { type: "object" } }, ["project_id", "client_id", "device_id", "agent", "message"]) },
  { name: "send_to_project_agent", description: "Send or steer a natural-language instruction to a project agent.", inputSchema: objectSchema({ project_run_id: { type: "string" }, message: { type: "string" }, delivery: { enum: ["auto", "steer", "queue", "interrupt"] } }, ["project_run_id", "message"]) },
  { name: "request_project_report", description: "Ask a project agent to produce a semantic status report.", inputSchema: objectSchema({ project_run_id: { type: "string" }, focus: { type: "string" } }, ["project_run_id"]) },
  { name: "list_pending_agent_messages", description: "List reports, questions and alerts awaiting the main agent.", inputSchema: objectSchema() },
  { name: "get_agent_message", description: "Read one report, question or runtime alert.", inputSchema: objectSchema({ message_id: { type: "string" } }, ["message_id"]) },
  { name: "acknowledge_project_report", description: "Acknowledge a project agent report.", inputSchema: objectSchema({ message_id: { type: "string" } }, ["message_id"]) },
  { name: "answer_project_agent", description: "Answer a project agent question and resume its work.", inputSchema: objectSchema({ question_id: { type: "string" }, answer: { type: "string" } }, ["question_id", "answer"]) },
  { name: "resolve_project_approval", description: "Resolve an approval waiting in a project agent session.", inputSchema: objectSchema({ project_run_id: { type: "string" }, approval_id: { type: "string" }, decision: { type: "object" } }, ["project_run_id", "approval_id", "decision"]) },
  { name: "change_project_agent_profile", description: "Switch a project agent to a complete profile stored by the Console.", inputSchema: objectSchema({ project_run_id: { type: "string" }, runtime_profile_id: { type: "string" }, apply: { enum: ["after_turn", "interrupt"] } }, ["project_run_id", "runtime_profile_id"]) },
  { name: "change_project_agent_model", description: "Change the model within the project agent's current profile/provider.", inputSchema: objectSchema({ project_run_id: { type: "string" }, model: { type: "string" }, apply: { enum: ["next_turn", "interrupt"] } }, ["project_run_id", "model"]) },
  { name: "change_project_agent_permissions", description: "Change a project agent's runtime tool approval policy.", inputSchema: objectSchema({ project_run_id: { type: "string" }, policy: { type: "object" }, apply: { enum: ["next_turn", "interrupt"] } }, ["project_run_id", "policy"]) },
  { name: "get_project_agent_goal", description: "Read a project agent's native active goal.", inputSchema: objectSchema({ project_run_id: { type: "string" } }, ["project_run_id"]) },
  { name: "set_project_agent_goal", description: "Set a project agent's native goal.", inputSchema: objectSchema({ project_run_id: { type: "string" }, objective: { type: "string" }, token_budget: { type: "number" } }, ["project_run_id", "objective"]) },
  { name: "clear_project_agent_goal", description: "Clear a project agent's native goal.", inputSchema: objectSchema({ project_run_id: { type: "string" } }, ["project_run_id"]) },
  { name: "close_project_agent", description: "Close a project agent run.", inputSchema: objectSchema({ project_run_id: { type: "string" } }, ["project_run_id"]) },
];

const PROJECT_TOOLS: Tool[] = [
  { name: "get_project_tree", description: "Read the bound project's Part/Phase/Step tree.", inputSchema: objectSchema({ include_done: { type: "boolean" } }) },
  { name: "create_node", description: "Create a Part, Phase or Step in the bound project.", inputSchema: objectSchema({ parent_id: { type: ["string", "null"] }, node_type: { enum: ["part", "phase", "step"] }, title: { type: "string" }, description: { type: "string" }, acceptance_criteria: { type: "string" }, priority: { type: "string" }, tags: { type: "array", items: { type: "string" } }, reason: { type: "string" } }, ["node_type", "title", "reason"]) },
  { name: "update_node", description: "Update a project node.", inputSchema: objectSchema({ node_id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, acceptance_criteria: { type: "string" }, priority: { type: "string" }, tags: { type: "array", items: { type: "string" } }, reason: { type: "string" } }, ["node_id", "reason"]) },
  { name: "set_current_focus", description: "Set the Step currently being worked on.", inputSchema: objectSchema({ node_id: { type: "string" }, reason: { type: "string" } }, ["node_id", "reason"]) },
  { name: "update_status", description: "Update a node status. Done requires evidence_summary; blocked requires blocker_reason and next_action.", inputSchema: objectSchema({ node_id: { type: "string" }, status: { type: "string" }, progress: { type: "number" }, evidence_summary: { type: "string" }, blocker_reason: { type: "string" }, next_action: { type: "string" }, reason: { type: "string" } }, ["node_id", "status", "reason"]) },
  { name: "add_evidence", description: "Attach verifiable evidence to a project node.", inputSchema: objectSchema({ node_id: { type: "string" }, evidence_type: { type: "string" }, title: { type: "string" }, content: { type: "string" }, summary: { type: "string" }, confidence: { type: "string" } }, ["node_id", "evidence_type", "title", "content"]) },
  { name: "create_checkpoint", description: "Create a structured project checkpoint.", inputSchema: objectSchema({ agent_name: { type: "string" }, current_focus_node_id: { type: "string" }, completed: { type: "array" }, in_progress: { type: "array" }, next: { type: "array" }, blockers: { type: "array" }, risks: { type: "array" }, summary: { type: "string" } }, ["agent_name", "summary"]) },
  { name: "report_to_main", description: "Send a concise progress, milestone, completion, blocked or failure report to the main agent only when needed.", inputSchema: objectSchema({ kind: { enum: ["progress", "milestone", "completed", "blocked", "failed"] }, summary: { type: "string" }, needs_response: { type: "boolean" }, related_step_ids: { type: "array", items: { type: "string" } }, evidence_summary: { type: "string" } }, ["kind", "summary"]) },
  { name: "ask_main", description: "Ask the main agent for a decision that the project agent cannot make safely.", inputSchema: objectSchema({ question: { type: "string" }, context: { type: "string" }, options: { type: "array" }, recommended_option: { type: "string" }, blocking: { type: "boolean" } }, ["question", "context", "blocking"]) },
  { name: "get_main_answer", description: "Read the answer to a previously submitted question.", inputSchema: objectSchema({ question_id: { type: "string" } }, ["question_id"]) },
];

const tools = role === "orchestrator" ? ORCHESTRATOR_TOOLS : PROJECT_TOOLS;

function endpoint(name: string, args: Json): { method: string; path: string; body?: Json } {
  if (role === "orchestrator") {
    const root = `/api/orchestrator/sessions/${encodeURIComponent(mainSessionId)}`;
    switch (name) {
      case "list_projects": return { method: "GET", path: "/api/projects" };
      case "get_project_portfolio": return { method: "GET", path: "/api/portfolio" };
      case "get_project": return { method: "GET", path: `/api/projects/${encodeURIComponent(String(args.project_id))}` };
      case "create_project": return { method: "POST", path: "/api/projects", body: args };
      case "update_project": {
        const { project_id, ...body } = args;
        return { method: "PATCH", path: `/api/projects/${encodeURIComponent(String(project_id))}`, body };
      }
      case "list_execution_targets": return { method: "GET", path: "/api/orchestrator/execution-targets" };
      case "list_runtime_profiles": return { method: "GET", path: "/api/runtime-profiles" };
      case "list_project_agents": return { method: "GET", path: `${root}/project-runs` };
      case "start_project_agent": return { method: "POST", path: `${root}/project-runs`, body: args };
      case "send_to_project_agent": return { method: "POST", path: `/api/agent-runs/${args.project_run_id}/messages`, body: args };
      case "request_project_report": return { method: "POST", path: `/api/agent-runs/${args.project_run_id}/report-request`, body: args };
      case "list_pending_agent_messages": return { method: "GET", path: `${root}/messages?status=pending` };
      case "get_agent_message": return { method: "GET", path: `/api/orchestrator/messages/${args.message_id}` };
      case "acknowledge_project_report": return { method: "POST", path: `/api/orchestrator/messages/${args.message_id}/ack`, body: {} };
      case "answer_project_agent": return { method: "POST", path: `/api/orchestrator/questions/${args.question_id}/answer`, body: { answer: args.answer } };
      case "resolve_project_approval": return { method: "POST", path: `/api/agent-runs/${args.project_run_id}/approvals/${args.approval_id}`, body: { decision: args.decision } };
      case "change_project_agent_profile": return { method: "POST", path: `/api/agent-runs/${args.project_run_id}/profile`, body: args };
      case "change_project_agent_model": return { method: "POST", path: `/api/agent-runs/${args.project_run_id}/model`, body: args };
      case "change_project_agent_permissions": return { method: "POST", path: `/api/agent-runs/${args.project_run_id}/permissions`, body: args };
      case "get_project_agent_goal": return { method: "GET", path: `/api/agent-runs/${args.project_run_id}/goal` };
      case "set_project_agent_goal": return { method: "PUT", path: `/api/agent-runs/${args.project_run_id}/goal`, body: args };
      case "clear_project_agent_goal": return { method: "DELETE", path: `/api/agent-runs/${args.project_run_id}/goal` };
      case "close_project_agent": return { method: "POST", path: `/api/agent-runs/${args.project_run_id}/close`, body: {} };
    }
  } else {
    const project = encodeURIComponent(projectId);
    const run = encodeURIComponent(projectRunId);
    switch (name) {
      case "get_project_tree": return { method: "GET", path: `/api/projects/${project}/tree?include_done=${args.include_done === false ? "false" : "true"}` };
      case "create_node": return { method: "POST", path: "/api/nodes", body: { ...args, project_id: projectId } };
      case "update_node": { const { node_id, ...body } = args; return { method: "PATCH", path: `/api/nodes/${node_id}`, body }; }
      case "set_current_focus": return { method: "POST", path: `/api/projects/${project}/focus`, body: args };
      case "update_status": { const { node_id, ...body } = args; return { method: "POST", path: `/api/nodes/${node_id}/status`, body }; }
      case "add_evidence": { const { node_id, ...body } = args; return { method: "POST", path: `/api/nodes/${node_id}/evidence`, body }; }
      case "create_checkpoint": return { method: "POST", path: `/api/projects/${project}/checkpoints`, body: args };
      case "report_to_main": return { method: "POST", path: `/api/agent-runs/${run}/reports`, body: args };
      case "ask_main": return { method: "POST", path: `/api/agent-runs/${run}/questions`, body: args };
      case "get_main_answer": return { method: "GET", path: `/api/agent-runs/${run}/questions/${args.question_id}` };
    }
  }
  throw new Error(`unsupported tool: ${name}`);
}

async function callHttp(method: string, path: string, body?: Json): Promise<unknown> {
  const url = new URL(path, baseUrl);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method,
      headers: {
        accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data: unknown = text;
        try { data = text ? JSON.parse(text) : {}; } catch { /* keep text */ }
        if ((response.statusCode ?? 500) >= 400) reject(new Error(`Console ${response.statusCode}: ${text}`));
        else resolve(data);
      });
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handle(line);
  }
});

async function handle(line: string): Promise<void> {
  let message: any;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id == null) return;
  try {
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: `agent-project-console-${role}`, version: "0.2.0" } } });
      return;
    }
    if (message.method === "ping") { send({ jsonrpc: "2.0", id: message.id, result: {} }); return; }
    if (message.method === "tools/list") { send({ jsonrpc: "2.0", id: message.id, result: { tools } }); return; }
    if (message.method === "tools/call") {
      const name = String(message.params?.name ?? "");
      if (!tools.some((tool) => tool.name === name)) throw new Error(`unknown tool: ${name}`);
      const args = (message.params?.arguments ?? {}) as Json;
      const target = endpoint(name, args);
      const result = await callHttp(target.method, target.path, target.body);
      send({ jsonrpc: "2.0", id: message.id, result: { isError: false, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  } catch (error) {
    send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } });
  }
}
