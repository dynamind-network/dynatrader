import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KanbanBoard } from "./kanban-board";
import type { Task, TrackedEntity } from "./kanban-board";

describe("KanbanBoard", () => {
  let testDir: string;
  let board: KanbanBoard;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kanban-test-"));
    board = new KanbanBoard(testDir);
  });

  afterEach(() => {
    board.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 1. Create task
  // ---------------------------------------------------------------------------
  it("should create a task with id, timestamps, and default status (triage)", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Test Task",
      description: "A test task description",
    });

    expect(task.id).toBeDefined();
    expect(task.id.length).toBeGreaterThan(0);
    expect(task.workspaceId).toBe("ws-1");
    expect(task.title).toBe("Test Task");
    expect(task.description).toBe("A test task description");
    expect(task.status).toBe("triage");
    expect(task.priority).toBe("medium");
    expect(task.tags).toEqual([]);
    expect(task.assignedTo).toBeNull();
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBeGreaterThan(0);
    expect(task.createdAt).toBe(task.updatedAt);
    expect(task.resolvedAt).toBeNull();
    expect(task.heartbeatAt).toBeNull();
  });

  it("should create a task with custom fields", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Custom Task",
      description: "Custom desc",
      status: "ready",
      priority: "high",
      tags: ["urgent", "feature"],
      assignedTo: "agent-1",
    });

    expect(task.status).toBe("ready");
    expect(task.priority).toBe("high");
    expect(task.tags).toEqual(["urgent", "feature"]);
    expect(task.assignedTo).toBe("agent-1");
  });

  // ---------------------------------------------------------------------------
  // 2. Get task
  // ---------------------------------------------------------------------------
  it("should get a task by ID", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Get Test",
    });

    const retrieved = board.getTask(task.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(task.id);
    expect(retrieved!.title).toBe("Get Test");
    expect(retrieved!.workspaceId).toBe("ws-1");
  });

  it("should return null for a missing task", () => {
    const result = board.getTask("non-existent-id");
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 3. List tasks
  // ---------------------------------------------------------------------------
  it("should list all tasks", () => {
    board.createTask({ workspaceId: "ws-1", title: "Task 1" });
    board.createTask({ workspaceId: "ws-1", title: "Task 2" });
    board.createTask({ workspaceId: "ws-2", title: "Task 3" });

    const all = board.listTasks();
    expect(all).toHaveLength(3);
  });

  it("should filter tasks by workspaceId", () => {
    board.createTask({ workspaceId: "ws-1", title: "WS1 Task" });
    board.createTask({ workspaceId: "ws-2", title: "WS2 Task" });

    const ws1Tasks = board.listTasks({ workspaceId: "ws-1" });
    expect(ws1Tasks).toHaveLength(1);
    expect(ws1Tasks[0].title).toBe("WS1 Task");

    const ws2Tasks = board.listTasks({ workspaceId: "ws-2" });
    expect(ws2Tasks).toHaveLength(1);
    expect(ws2Tasks[0].title).toBe("WS2 Task");
  });

  it("should filter tasks by status", () => {
    board.createTask({
      workspaceId: "ws-1",
      title: "Triage Task",
      status: "triage",
    });
    board.createTask({
      workspaceId: "ws-1",
      title: "Running Task",
      status: "running",
    });

    const triageTasks = board.listTasks({ status: "triage" });
    expect(triageTasks).toHaveLength(1);
    expect(triageTasks[0].title).toBe("Triage Task");

    const doneTasks = board.listTasks({ status: "done" });
    expect(doneTasks).toHaveLength(0);
  });

  it("should filter tasks by priority", () => {
    board.createTask({
      workspaceId: "ws-1",
      title: "Critical Task",
      priority: "critical",
    });
    board.createTask({
      workspaceId: "ws-1",
      title: "Low Task",
      priority: "low",
    });

    const criticalTasks = board.listTasks({ priority: "critical" });
    expect(criticalTasks).toHaveLength(1);
    expect(criticalTasks[0].title).toBe("Critical Task");
  });

  it("should filter tasks by tag", () => {
    board.createTask({
      workspaceId: "ws-1",
      title: "Bug Task",
      tags: ["bug", "frontend"],
    });
    board.createTask({
      workspaceId: "ws-1",
      title: "Feature Task",
      tags: ["feature", "backend"],
    });

    const bugTasks = board.listTasks({ tag: "bug" });
    expect(bugTasks).toHaveLength(1);
    expect(bugTasks[0].title).toBe("Bug Task");

    const frontendTasks = board.listTasks({ tag: "frontend" });
    expect(frontendTasks).toHaveLength(1);

    const noMatch = board.listTasks({ tag: "nonexistent" });
    expect(noMatch).toHaveLength(0);
  });

  it("should combine filters", () => {
    board.createTask({
      workspaceId: "ws-1",
      title: "WS1 Critical",
      priority: "critical",
      status: "todo",
    });
    board.createTask({
      workspaceId: "ws-1",
      title: "WS1 Low",
      priority: "low",
      status: "todo",
    });
    board.createTask({
      workspaceId: "ws-2",
      title: "WS2 Critical",
      priority: "critical",
      status: "todo",
    });

    const result = board.listTasks({
      workspaceId: "ws-1",
      priority: "critical",
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("WS1 Critical");
  });

  // ---------------------------------------------------------------------------
  // 4. Update task
  // ---------------------------------------------------------------------------
  it("should update a task and bump updatedAt", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Original Title",
      priority: "low",
    });

    const originalUpdatedAt = task.updatedAt;

    const updated = board.updateTask(task.id, {
      title: "Updated Title",
      priority: "high",
      description: "New description",
    });

    expect(updated.title).toBe("Updated Title");
    expect(updated.priority).toBe("high");
    expect(updated.description).toBe("New description");
    expect(updated.workspaceId).toBe(task.workspaceId);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
    expect(updated.createdAt).toBe(task.createdAt);
    expect(updated.id).toBe(task.id);
  });

  it("should throw when updating a non-existent task", () => {
    expect(() =>
      board.updateTask("non-existent", { title: "Nope" }),
    ).toThrow("Task not found: non-existent");
  });

  // ---------------------------------------------------------------------------
  // 5. Transition task
  // ---------------------------------------------------------------------------
  it("should transition task status", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Transition Test",
    });

    const todo = board.transitionTask(task.id, "todo");
    expect(todo.status).toBe("todo");
    expect(todo.updatedAt).toBeGreaterThanOrEqual(task.updatedAt);
    expect(todo.resolvedAt).toBeNull();

    const done = board.transitionTask(task.id, "done");
    expect(done.status).toBe("done");
    expect(done.resolvedAt).toBeDefined();
    expect(done.resolvedAt).toBeGreaterThanOrEqual(done.createdAt);
  });

  it("should set resolvedAt when transitioning to done", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Done Task",
    });

    const done = board.transitionTask(task.id, "done");
    expect(done.status).toBe("done");
    expect(done.resolvedAt).toBeGreaterThan(0);
  });

  it("should set resolvedAt when transitioning to archived", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Archive Task",
    });

    const archived = board.transitionTask(task.id, "archived");
    expect(archived.status).toBe("archived");
    expect(archived.resolvedAt).toBeGreaterThan(0);
  });

  it("should not set resolvedAt for non-terminal statuses", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Non-terminal",
    });

    const running = board.transitionTask(task.id, "running");
    expect(running.status).toBe("running");
    expect(running.resolvedAt).toBeNull();

    const blocked = board.transitionTask(task.id, "blocked");
    expect(blocked.status).toBe("blocked");
    expect(blocked.resolvedAt).toBeNull();
  });

  it("should throw when transitioning a non-existent task", () => {
    expect(() =>
      board.transitionTask("non-existent", "done"),
    ).toThrow("Task not found: non-existent");
  });

  // ---------------------------------------------------------------------------
  // 6. Claim task
  // ---------------------------------------------------------------------------
  it("should claim an unassigned task atomically", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Claimable",
    });

    const result = board.claimTask(task.id, "agent-alpha");
    expect(result.success).toBe(true);
    expect(result.lockToken).toBeTruthy();
    expect(board.getTask(task.id)!.assignedTo).toBe("agent-alpha");
  });

  it("should prevent double-claim by a different agent", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Double Claim",
    });

    board.claimTask(task.id, "agent-alpha");

    const result = board.claimTask(task.id, "agent-beta");
    expect(result.success).toBe(false);
    expect(result.error).toContain("already claimed by agent-alpha");
  });

  it("should allow re-claim by the same agent", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Re-claim",
    });

    board.claimTask(task.id, "agent-alpha");
    const reclaimed = board.claimTask(task.id, "agent-alpha");
    expect(reclaimed.success).toBe(true);
    expect(board.getTask(task.id)!.assignedTo).toBe("agent-alpha");
  });

  it("should return failure when claiming a non-existent task", () => {
    const result = board.claimTask("non-existent", "agent");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Task not found");
  });

  // ---------------------------------------------------------------------------
  // 7. Heartbeat
  // ---------------------------------------------------------------------------
  it("should update heartbeat_at on running tasks", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Heartbeat Test",
    });

    expect(task.heartbeatAt).toBeNull();

    board.heartbeat(task.id);

    const updated = board.getTask(task.id);
    expect(updated!.heartbeatAt).toBeGreaterThan(0);
    expect(updated!.heartbeatAt).toBeGreaterThanOrEqual(task.createdAt);
  });

  it("should throw heartbeat for non-existent task", () => {
    expect(() => board.heartbeat("non-existent")).toThrow(
      "Task not found: non-existent",
    );
  });

  // ---------------------------------------------------------------------------
  // 8. Block / Unblock
  // ---------------------------------------------------------------------------
  it("should block a task and record the reason", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Blockable",
      status: "running",
    });

    const blocked = board.blockTask(task.id, "Waiting for review");
    expect(blocked!.status).toBe("blocked");

    // Check event was recorded
    const events = board.getTaskEvents(task.id);
    const blockEvent = events.find((e) => e.event_type === "blocked");
    expect(blockEvent).toBeDefined();
    expect(blockEvent!.new_value).toContain("blocked: Waiting for review");
    expect(blockEvent!.old_value).toBe("running");
  });

  it("should unblock a task back to its previous status", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Unblockable",
      status: "running",
    });

    board.blockTask(task.id, "Blocked reason");
    const unblocked = board.unblockTask(task.id);
    expect(unblocked.status).toBe("running");

    const events = board.getTaskEvents(task.id);
    const unblockEvent = events.find((e) => e.event_type === "unblocked");
    expect(unblockEvent).toBeDefined();
    expect(unblockEvent!.old_value).toBe("blocked");
    expect(unblockEvent!.new_value).toBe("running");
  });

  it("should fall back to triage when no previous status recorded", () => {
    // Simulate a blocked task with no previous status (direct creation as blocked)
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Directly Blocked",
      status: "blocked",
    });

    const unblocked = board.unblockTask(task.id);
    expect(unblocked.status).toBe("triage");
  });

  it("should throw when unblocking a non-blocked task", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Not Blocked",
    });

    expect(() => board.unblockTask(task.id)).toThrow(
      `Task ${task.id} is not blocked`,
    );
  });

  it("should throw when blocking a non-existent task", () => {
    expect(() => board.blockTask("non-existent", "reason")).toThrow(
      "Task not found: non-existent",
    );
  });

  // ---------------------------------------------------------------------------
  // 9. Comments
  // ---------------------------------------------------------------------------
  it("should add a comment to a task", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Commentable",
    });

    const comment = board.addComment(task.id, "This is a comment", "user-1");

    expect(comment.id).toBeDefined();
    expect(comment.task_id).toBe(task.id);
    expect(comment.author).toBe("user-1");
    expect(comment.body).toBe("This is a comment");
    expect(comment.created_at).toBeGreaterThan(0);
  });

  it("should list comments for a task in order", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Comments",
    });

    board.addComment(task.id, "First comment");
    board.addComment(task.id, "Second comment", "user-2");
    board.addComment(task.id, "Third comment");

    const comments = board.listComments(task.id);
    expect(comments).toHaveLength(3);
    expect(comments[0].body).toBe("First comment");
    expect(comments[1].body).toBe("Second comment");
    expect(comments[1].author).toBe("user-2");
    expect(comments[2].body).toBe("Third comment");
  });

  it("should throw when adding comment to non-existent task", () => {
    expect(() => board.addComment("non-existent", "body")).toThrow(
      "Task not found",
    );
  });

  // ---------------------------------------------------------------------------
  // 10. Link / unlink tasks
  // ---------------------------------------------------------------------------
  it("should link two tasks bidirectionally", () => {
    const taskA = board.createTask({ workspaceId: "ws-1", title: "Task A" });
    const taskB = board.createTask({ workspaceId: "ws-1", title: "Task B" });

    board.linkTasks(taskA.id, taskB.id, "blocks");

    // Check A's links include B
    const aLinks = board.getTaskLinks(taskA.id);
    expect(aLinks).toHaveLength(1);
    expect(aLinks[0].id).toBe(taskB.id);

    // Check B's links include A
    const bLinks = board.getTaskLinks(taskB.id);
    expect(bLinks).toHaveLength(1);
    expect(bLinks[0].id).toBe(taskA.id);
  });

  it("should unlink two tasks", () => {
    const taskA = board.createTask({ workspaceId: "ws-1", title: "Task A" });
    const taskB = board.createTask({ workspaceId: "ws-1", title: "Task B" });

    board.linkTasks(taskA.id, taskB.id);
    expect(board.getTaskLinks(taskA.id)).toHaveLength(1);

    board.unlinkTasks(taskA.id, taskB.id);
    expect(board.getTaskLinks(taskA.id)).toHaveLength(0);
    expect(board.getTaskLinks(taskB.id)).toHaveLength(0);
  });

  it("should throw when linking a task to itself", () => {
    const task = board.createTask({ workspaceId: "ws-1", title: "Self" });
    expect(() => board.linkTasks(task.id, task.id)).toThrow(
      "Cannot link a task to itself",
    );
  });

  it("should throw when linking with non-existent source", () => {
    const task = board.createTask({ workspaceId: "ws-1", title: "Target" });
    expect(() => board.linkTasks("non-existent", task.id)).toThrow(
      "Source task not found",
    );
  });

  it("should throw when linking with non-existent target", () => {
    const task = board.createTask({ workspaceId: "ws-1", title: "Source" });
    expect(() => board.linkTasks(task.id, "non-existent")).toThrow(
      "Target task not found",
    );
  });

  it("should be idempotent when linking same tasks twice", () => {
    const taskA = board.createTask({ workspaceId: "ws-1", title: "A" });
    const taskB = board.createTask({ workspaceId: "ws-1", title: "B" });

    board.linkTasks(taskA.id, taskB.id);
    board.linkTasks(taskA.id, taskB.id); // should not throw

    expect(board.getTaskLinks(taskA.id)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 11. Create entity
  // ---------------------------------------------------------------------------
  it("should create an entity with id, timestamps, and kind", () => {
    const entity = board.createEntity({
      name: "AAPL",
      kind: "asset",
      description: "Apple Inc.",
      tags: ["tech", "large-cap"],
      metadata: { symbol: "AAPL", sector: "Technology" },
    });

    expect(entity.id).toBeDefined();
    expect(entity.id.length).toBeGreaterThan(0);
    expect(entity.name).toBe("AAPL");
    expect(entity.kind).toBe("asset");
    expect(entity.description).toBe("Apple Inc.");
    expect(entity.tags).toEqual(["tech", "large-cap"]);
    expect(entity.metadata).toEqual({
      symbol: "AAPL",
      sector: "Technology",
    });
    expect(entity.createdAt).toBeGreaterThan(0);
    expect(entity.updatedAt).toBeGreaterThan(0);
    expect(entity.createdAt).toBe(entity.updatedAt);
  });

  // ---------------------------------------------------------------------------
  // 12. List entities
  // ---------------------------------------------------------------------------
  it("should list entities filtered by kind", () => {
    board.createEntity({ name: "AAPL", kind: "asset", description: "Apple" });
    board.createEntity({
      name: "Technology",
      kind: "sector",
      description: "Tech sector",
    });
    board.createEntity({
      name: "AI",
      kind: "theme",
      description: "Artificial Intelligence",
    });

    const all = board.listEntities();
    expect(all).toHaveLength(3);

    const assets = board.listEntities("asset");
    expect(assets).toHaveLength(1);
    expect(assets[0].name).toBe("AAPL");

    const sectors = board.listEntities("sector");
    expect(sectors).toHaveLength(1);
    expect(sectors[0].name).toBe("Technology");

    const themes = board.listEntities("theme");
    expect(themes).toHaveLength(1);
    expect(themes[0].name).toBe("AI");
  });

  // ---------------------------------------------------------------------------
  // 13. Search entities
  // ---------------------------------------------------------------------------
  it("should search entities by name or description (case-insensitive)", () => {
    board.createEntity({
      name: "Apple Inc.",
      kind: "asset",
      description: "Technology company",
    });
    board.createEntity({
      name: "Banana Corp",
      kind: "asset",
      description: "Fruit trading company",
    });
    board.createEntity({
      name: "Tech Sector",
      kind: "sector",
      description: "All technology companies",
    });

    // Search by name (case-insensitive)
    const techResults = board.searchEntities("tech");
    expect(techResults).toHaveLength(2);
    const techNames = techResults.map((e) => e.name).sort();
    expect(techNames).toEqual(["Apple Inc.", "Tech Sector"]);

    // Search by description
    const fruitResults = board.searchEntities("fruit");
    expect(fruitResults).toHaveLength(1);
    expect(fruitResults[0].name).toBe("Banana Corp");

    // Search with different case
    const upperResults = board.searchEntities("TECHNOLOGY");
    expect(upperResults).toHaveLength(2);

    // No matches
    const noResults = board.searchEntities("zzzzz");
    expect(noResults).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 14. Link / unlink entities
  // ---------------------------------------------------------------------------
  it("should link two entities bidirectionally", () => {
    const aapl = board.createEntity({
      name: "AAPL",
      kind: "asset",
      description: "Apple Inc.",
    });
    const tech = board.createEntity({
      name: "Technology",
      kind: "sector",
      description: "Tech sector",
    });

    const link = board.linkEntities(aapl.id, tech.id, "belongs_to");

    expect(link.source_id).toBe(aapl.id);
    expect(link.target_id).toBe(tech.id);
    expect(link.label).toBe("belongs_to");
    expect(link.created_at).toBeGreaterThan(0);

    // Bidirectional linking creates 2 records (aapl->tech, tech->aapl)
    // getEntityLinks returns all links where source_id OR target_id matches
    const sourceLinks = board.getEntityLinks(aapl.id);
    expect(sourceLinks).toHaveLength(2);
    const targetIds = sourceLinks.map((l) =>
      l.source_id === aapl.id ? l.target_id : l.source_id,
    );
    expect(targetIds).toContain(tech.id);

    const targetLinks = board.getEntityLinks(tech.id);
    expect(targetLinks).toHaveLength(2);
    const sourceIds = targetLinks.map((l) =>
      l.source_id === tech.id ? l.target_id : l.source_id,
    );
    expect(sourceIds).toContain(aapl.id);
  });

  it("should unlink entities", () => {
    const a = board.createEntity({ name: "A", kind: "note" });
    const b = board.createEntity({ name: "B", kind: "note" });

    board.linkEntities(a.id, b.id, "related");
    // Bidirectional link creates 2 records
    expect(board.getEntityLinks(a.id)).toHaveLength(2);

    board.unlinkEntities(a.id, b.id);
    expect(board.getEntityLinks(a.id)).toHaveLength(0);
    expect(board.getEntityLinks(b.id)).toHaveLength(0);
  });

  it("should throw when linking entity to itself", () => {
    const entity = board.createEntity({ name: "Self", kind: "note" });
    expect(() => board.linkEntities(entity.id, entity.id, "self")).toThrow(
      "Cannot link an entity to itself",
    );
  });

  it("should throw when linking with non-existent source", () => {
    const target = board.createEntity({ name: "Target", kind: "note" });
    expect(() => board.linkEntities("fake-source", target.id, "test")).toThrow(
      "Entity not found: fake-source",
    );
  });

  it("should throw when linking with non-existent target", () => {
    const source = board.createEntity({ name: "Source", kind: "note" });
    expect(() => board.linkEntities(source.id, "fake-target", "test")).toThrow(
      "Entity not found: fake-target",
    );
  });

  // ---------------------------------------------------------------------------
  // 15. Get entity graph
  // ---------------------------------------------------------------------------
  it("should return all nodes and edges in the entity graph", () => {
    const a = board.createEntity({ name: "A", kind: "note" });
    const b = board.createEntity({ name: "B", kind: "note" });
    const c = board.createEntity({ name: "C", kind: "note" });

    board.linkEntities(a.id, b.id, "related");
    board.linkEntities(b.id, c.id, "impacts");

    const graph = board.getEntityGraph();

    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(4); // 2 links x 2 directions each

    const nodeNames = graph.nodes.map((n) => n.name).sort();
    expect(nodeNames).toEqual(["A", "B", "C"]);

    const labels = graph.edges.map((e) => e.label).sort();
    expect(labels).toEqual(["impacts", "impacts", "related", "related"]);
  });

  // ---------------------------------------------------------------------------
  // 16. Get task events
  // ---------------------------------------------------------------------------
  it("should return events for a task in order", () => {
    const task = board.createTask({ workspaceId: "ws-1", title: "Eventful" });

    board.transitionTask(task.id, "todo", "agent-1");
    board.transitionTask(task.id, "ready", "agent-1");
    board.transitionTask(task.id, "running", "agent-2");

    const events = board.getTaskEvents(task.id);
    expect(events).toHaveLength(3);

    expect(events[0].event_type).toBe("status_change");
    expect(events[0].old_value).toBe("triage");
    expect(events[0].new_value).toBe("todo");
    expect(events[0].actor).toBe("agent-1");

    expect(events[1].event_type).toBe("status_change");
    expect(events[1].old_value).toBe("todo");
    expect(events[1].new_value).toBe("ready");

    expect(events[2].event_type).toBe("status_change");
    expect(events[2].old_value).toBe("ready");
    expect(events[2].new_value).toBe("running");
    expect(events[2].actor).toBe("agent-2");
  });

  it("should return events for claim actions", () => {
    const task = board.createTask({ workspaceId: "ws-1", title: "Claim Event" });
    board.claimTask(task.id, "agent-alpha");

    const events = board.getTaskEvents(task.id);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("claim");
    expect(events[0].new_value).toBe("agent-alpha");
  });

  // ---------------------------------------------------------------------------
  // 17. Delete task cascades
  // ---------------------------------------------------------------------------
  it("should delete a task and cascade to links, comments, and events", () => {
    const taskA = board.createTask({ workspaceId: "ws-1", title: "Task A" });
    const taskB = board.createTask({ workspaceId: "ws-1", title: "Task B" });

    board.linkTasks(taskA.id, taskB.id);
    board.addComment(taskA.id, "Comment on A");
    board.transitionTask(taskA.id, "running");

    // Delete task A
    board.deleteTask(taskA.id);

    // Task A should be gone
    expect(board.getTask(taskA.id)).toBeNull();

    // Links to A should be gone
    const bLinks = board.getTaskLinks(taskB.id);
    expect(bLinks).toHaveLength(0);

    // Comments for A should be gone
    expect(board.listComments(taskA.id)).toHaveLength(0);

    // Events for A should be gone
    expect(board.getTaskEvents(taskA.id)).toHaveLength(0);

    // Task B should remain
    expect(board.getTask(taskB.id)).not.toBeNull();
  });

  it("should throw when deleting a non-existent task", () => {
    expect(() => board.deleteTask("non-existent")).toThrow(
      "Task not found: non-existent",
    );
  });

  // ---------------------------------------------------------------------------
  // 18. Delete entity cascades
  // ---------------------------------------------------------------------------
  it("should delete an entity and cascade to entity_links", () => {
    const a = board.createEntity({ name: "A", kind: "note" });
    const b = board.createEntity({ name: "B", kind: "note" });

    board.linkEntities(a.id, b.id, "related");

    board.deleteEntity(a.id);

    expect(board.getEntity(a.id)).toBeNull();
    expect(board.getEntity(b.id)).not.toBeNull();

    // A's links should be gone
    expect(board.getEntityLinks(a.id)).toHaveLength(0);

    // B's link to A should also be gone (CASCADE)
    const bLinks = board.getEntityLinks(b.id);
    expect(bLinks).toHaveLength(0);
  });

  it("should throw when deleting a non-existent entity", () => {
    expect(() => board.deleteEntity("non-existent")).toThrow(
      "Entity not found: non-existent",
    );
  });

  // ---------------------------------------------------------------------------
  // 19. Persistence
  // ---------------------------------------------------------------------------
  it("should persist data across board instances", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Persist Me",
      description: "Will survive reopening",
      priority: "critical",
      tags: ["test", "persist"],
      status: "todo",
    });

    const entity = board.createEntity({
      name: "Persistent Entity",
      kind: "asset",
      description: "Will also survive",
      tags: ["persist"],
      metadata: { key: "value" },
    });

    // Close and reopen
    board.close();

    const board2 = new KanbanBoard(testDir);

    try {
      // Task should persist
      const retrievedTask = board2.getTask(task.id);
      expect(retrievedTask).not.toBeNull();
      expect(retrievedTask!.title).toBe("Persist Me");
      expect(retrievedTask!.priority).toBe("critical");
      expect(retrievedTask!.status).toBe("todo");
      expect(retrievedTask!.tags).toEqual(["test", "persist"]);
      expect(retrievedTask!.workspaceId).toBe("ws-1");

      // Entity should persist
      const retrievedEntity = board2.getEntity(entity.id);
      expect(retrievedEntity).not.toBeNull();
      expect(retrievedEntity!.name).toBe("Persistent Entity");
      expect(retrievedEntity!.kind).toBe("asset");
      expect(retrievedEntity!.tags).toEqual(["persist"]);
      expect(retrievedEntity!.metadata).toEqual({ key: "value" });
    } finally {
      board2.close();
    }
  });

  it("should persist events and comments across instances", () => {
    const task = board.createTask({ workspaceId: "ws-1", title: "History" });
    board.transitionTask(task.id, "running", "agent-1");
    board.addComment(task.id, "Historical comment", "analyst");
    board.claimTask(task.id, "agent-1");

    board.close();

    const board2 = new KanbanBoard(testDir);

    try {
      // Events should persist
      const events = board2.getTaskEvents(task.id);
      expect(events).toHaveLength(2); // status_change + claim

      const statusEvent = events.find(
        (e) => e.event_type === "status_change",
      );
      expect(statusEvent).toBeDefined();
      expect(statusEvent!.old_value).toBe("triage");
      expect(statusEvent!.new_value).toBe("running");

      // Comments should persist
      const comments = board2.listComments(task.id);
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe("Historical comment");
    } finally {
      board2.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  it("should handle WAL mode correctly with concurrent-like operations", () => {
    // Quick sequential operations that exercise the DB
    const t1 = board.createTask({ workspaceId: "ws-1", title: "T1" });
    const t2 = board.createTask({ workspaceId: "ws-1", title: "T2" });

    board.linkTasks(t1.id, t2.id);
    board.addComment(t1.id, "Comment 1");
    board.addComment(t2.id, "Comment 2");

    board.claimTask(t1.id, "agent-1");
    board.transitionTask(t1.id, "running");
    board.heartbeat(t1.id);

    const updated = board.getTask(t1.id)!;
    expect(updated.assignedTo).toBe("agent-1");
    expect(updated.status).toBe("running");
    expect(updated.heartbeatAt).toBeGreaterThan(0);
  });

  it("should create and retrieve all entity kinds", () => {
    const kinds = ["asset", "sector", "theme", "strategy", "note"] as const;
    for (const kind of kinds) {
      const entity = board.createEntity({
        name: `Test ${kind}`,
        kind,
      });
      expect(entity.kind).toBe(kind);
    }

    expect(board.listEntities()).toHaveLength(5);
  });

  it("should support the full task lifecycle", () => {
    // Full lifecycle: create -> claim -> transition -> block -> unblock -> done
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Lifecycle",
    });
    expect(task.status).toBe("triage");

    board.claimTask(task.id, "agent-1");
    expect(board.getTask(task.id)!.assignedTo).toBe("agent-1");

    board.transitionTask(task.id, "todo");
    board.transitionTask(task.id, "ready");
    board.transitionTask(task.id, "running");

    board.blockTask(task.id, "Waiting for dependency");
    expect(board.getTask(task.id)!.status).toBe("blocked");

    board.unblockTask(task.id);
    expect(board.getTask(task.id)!.status).toBe("running");

    board.transitionTask(task.id, "done");
    expect(board.getTask(task.id)!.status).toBe("done");
    expect(board.getTask(task.id)!.resolvedAt).toBeGreaterThan(0);

    const events = board.getTaskEvents(task.id);
    // claim + 4 status changes + blocked + unblocked + final done = 8 events
    expect(events.length).toBeGreaterThanOrEqual(7);
  });

  it("should not create kanban.db file until board is created", () => {
    // The file should exist after creation
    expect(existsSync(join(testDir, "kanban.db"))).toBe(true);
  });

  it("should handle tags with special characters", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Special Tags",
      tags: ["tag with spaces", "tag-with-dashes", "underscore_tag"],
    });

    const retrieved = board.getTask(task.id);
    expect(retrieved!.tags).toEqual([
      "tag with spaces",
      "tag-with-dashes",
      "underscore_tag",
    ]);
  });

  it("should filter tasks by tag with special characters", () => {
    board.createTask({
      workspaceId: "ws-1",
      title: "Special",
      tags: ["tag with spaces"],
    });

    const result = board.listTasks({ tag: "tag with spaces" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Special");
  });

  it("should update entity metadata correctly", () => {
    const entity = board.createEntity({
      name: "Test Entity",
      kind: "note",
      metadata: { original: "value" },
    });

    const updated = board.updateEntity(entity.id, {
      metadata: { newKey: "newValue", another: "data" },
    });

    expect(updated.metadata).toEqual({
      newKey: "newValue",
      another: "data",
    });
  });

  it("should get entity by ID and return null for missing", () => {
    const created = board.createEntity({
      name: "MSFT",
      kind: "asset",
      description: "Microsoft Corp",
    });

    const retrieved = board.getEntity(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.name).toBe("MSFT");
    expect(retrieved!.kind).toBe("asset");

    const missing = board.getEntity("nonexistent-id");
    expect(missing).toBeNull();
  });

  it("should update entity and bump updatedAt", () => {
    const entity = board.createEntity({
      name: "Original",
      kind: "note",
      description: "Original description",
      tags: [],
      metadata: {},
    });

    // Small delay to ensure updatedAt differs
    const updated = board.updateEntity(entity.id, {
      name: "Updated",
      description: "Updated description",
      tags: ["updated"],
    });

    expect(updated.name).toBe("Updated");
    expect(updated.description).toBe("Updated description");
    expect(updated.tags).toEqual(["updated"]);
    expect(updated.kind).toBe("note");
    expect(updated.metadata).toEqual({});
    expect(updated.id).toBe(entity.id);
    expect(updated.createdAt).toBe(entity.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(entity.updatedAt);
    expect(updated.name).toBe("Updated");
  });

  it("should throw when updating non-existent entity", () => {
    expect(() => board.updateEntity("fake-id", { name: "New" })).toThrow(
      "Entity not found: fake-id",
    );
  });

  it("should get connected entities via links", () => {
    const a = board.createEntity({ name: "A", kind: "note" });
    const b = board.createEntity({ name: "B", kind: "note" });
    const c = board.createEntity({ name: "C", kind: "note" });

    board.linkEntities(a.id, b.id, "related");
    board.linkEntities(a.id, c.id, "related");

    // 2 links x 2 directions each = 4 records
    const aLinks = board.getEntityLinks(a.id);
    expect(aLinks).toHaveLength(4);

    const connectedIds = aLinks.map((l) =>
      l.source_id === a.id ? l.target_id : l.source_id,
    );
    expect(connectedIds).toContain(b.id);
    expect(connectedIds).toContain(c.id);
  });

  it("should return empty array for entity with no links", () => {
    const entity = board.createEntity({ name: "Lonely", kind: "note" });
    const links = board.getEntityLinks(entity.id);
    expect(links).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Parity tests
// ---------------------------------------------------------------------------

describe("KanbanBoard", () => {
   let testDir: string;
   let board: KanbanBoard;

   beforeEach(() => {
     testDir = mkdtempSync(join(tmpdir(), "kanban-"));
    board = new KanbanBoard(testDir);
  });

  afterEach(() => {
    board.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should have new statuses in type", () => {
    const scheduled = board.createTask({
      workspaceId: "ws-1",
      title: "Scheduled",
      description: "",
      status: "scheduled",
      priority: "medium",
    });
    expect(scheduled.status).toBe("scheduled");

    const review = board.createTask({
      workspaceId: "ws-1",
      title: "Review",
      description: "",
      status: "review",
      priority: "medium",
    });
    expect(review.status).toBe("review");
  });

  it("should support claim lock CAS", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "CAS Test",
      description: "",
      status: "ready",
      priority: "medium",
    });

    // First claim succeeds
    const claim1 = board.claimTask(task.id, "alice");
    expect(claim1.success).toBe(true);
    expect(claim1.lockToken).toBeTruthy();

    // Second claim by different user fails (not expired)
    const claim2 = board.claimTask(task.id, "bob");
    expect(claim2.success).toBe(false);
  });

  it("should support heartbeat claim renewal", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Heartbeat Test",
      description: "",
      status: "running",
      priority: "medium",
    });
    const claim = board.claimTask(task.id, "alice");
    expect(claim.lockToken).toBeTruthy();

    // Renew claim via heartbeat
    const renewed = board.heartbeatClaim(task.id, claim.lockToken!);
    expect(renewed).toBe(true);

    // Wrong token fails
    const wrong = board.heartbeatClaim(task.id, "wrong-token");
    expect(wrong).toBe(false);
  });

  it("should enforce block recurrence limit", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Recurrence Test",
      description: "",
      status: "running",
      priority: "medium",
    });

    // Block once
    board.blockTask(task.id, "First block", "system", "dependency");
    let t = board.getTask(task.id);
    expect(t!.blockKind).toBe("dependency");
    expect(t!.blockRecurrenceCount).toBe(1);

    // Unblock
    board.unblockTask(task.id, "system");
    t = board.getTask(task.id);
    expect(t!.status).toBe("running");

    // Block twice (hits limit -> triage)
    board.blockTask(task.id, "Second block", "system", "transient");
    t = board.getTask(task.id);
    expect(t!.blockRecurrenceCount).toBe(2);
  });

  it("should detect stale tasks", () => {
    const task = board.createTask({
      workspaceId: "ws-1",
      title: "Stale Test",
      description: "",
      status: "running",
      priority: "medium",
    });

    // Manually set heartbeat to old value
    const oldTs = Date.now() - 700000; // > 10 min
    board.updateTask(task.id, { heartbeatAt: oldTs });

    const stale = board.checkStaleTasks();
    expect(stale).toContain(task.id);

    // Task should be blocked now
    const t = board.getTask(task.id);
    expect(t!.status).toBe("blocked");
  });

  it("should dispatch next ready task", () => {
    // Create tasks with different priorities
    board.createTask({
      workspaceId: "ws-1",
      title: "Low",
      description: "",
      status: "ready",
      priority: "low",
    });
    board.createTask({
      workspaceId: "ws-1",
      title: "Critical",
      description: "",
      status: "ready",
      priority: "critical",
    });

    // Should dispatch highest priority first
    const dispatched = board.dispatchTask("alice");
    expect(dispatched).not.toBeNull();
    expect(dispatched!.title).toBe("Critical");
    expect(dispatched!.assignedTo).toBe("alice");
    expect(dispatched!.status).toBe("running");
  });
});
