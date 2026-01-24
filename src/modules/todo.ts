// ============================================================================
// Todo Module — Pure domain logic
// 
// This is a complete example of how to build a module:
// 1. Define State type
// 2. Define Command types (what user wants)
// 3. Define Event types (what happened)
// 4. Implement decide: Cmd → Event[]
// 5. Implement reduce: (State, Event, ts) → State
// ============================================================================

import type { Reducer, Decide } from "../core/types.js";

// ============================================================================
// State
// ============================================================================

export type TodoId = string;

export type Todo = {
  readonly id: TodoId;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: number;
  readonly doneAt?: number;
};

export type TodoState = {
  readonly todos: Readonly<Record<TodoId, Todo>>;
};

export const initial: TodoState = { todos: {} };

// ============================================================================
// Commands (what user wants to do)
// ============================================================================

export type TodoCmd =
  | { readonly type: "add"; readonly text: string }
  | { readonly type: "toggle"; readonly id: TodoId }
  | { readonly type: "delete"; readonly id: TodoId };

// ============================================================================
// Events (what happened — facts)
// ============================================================================

export type TodoEvent =
  | { readonly type: "todo.added"; readonly id: TodoId; readonly text: string }
  | { readonly type: "todo.toggled"; readonly id: TodoId }
  | { readonly type: "todo.deleted"; readonly id: TodoId };

// ============================================================================
// Decide: Cmd → Event[] (pure)
// ============================================================================

const makeId = (): TodoId => Math.random().toString(36).slice(2, 10);

export const decide: Decide<TodoCmd, TodoEvent> = (cmd) => {
  switch (cmd.type) {
    case "add":
      return [{ type: "todo.added", id: makeId(), text: cmd.text.trim() }];
    case "toggle":
      return [{ type: "todo.toggled", id: cmd.id }];
    case "delete":
      return [{ type: "todo.deleted", id: cmd.id }];
  }
};

// ============================================================================
// Reduce: (State, Event, ts) → State (pure fold step)
// ============================================================================

export const reduce: Reducer<TodoState, TodoEvent> = (state, event, ts) => {
  switch (event.type) {
    case "todo.added": {
      const todo: Todo = { id: event.id, text: event.text, done: false, createdAt: ts };
      return { ...state, todos: { ...state.todos, [todo.id]: todo } };
    }
    case "todo.toggled": {
      const t = state.todos[event.id];
      if (!t) return state;
      const next: Todo = { ...t, done: !t.done, doneAt: !t.done ? ts : undefined };
      return { ...state, todos: { ...state.todos, [event.id]: next } };
    }
    case "todo.deleted": {
      const { [event.id]: _, ...rest } = state.todos;
      return { ...state, todos: rest };
    }
  }
};
