import type { PlanEvent } from "@travel/shared";

type Subscriber = (event: PlanEvent) => void;

/** In-process fan-out of plan events to SSE subscribers. */
export class EventHub {
  private subscribers = new Map<string, Set<Subscriber>>();

  subscribe(planId: string, fn: Subscriber): () => void {
    let set = this.subscribers.get(planId);
    if (!set) {
      set = new Set();
      this.subscribers.set(planId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subscribers.delete(planId);
    };
  }

  publish(event: PlanEvent): void {
    const set = this.subscribers.get(event.planId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        // a broken subscriber must not break the workflow
      }
    }
  }
}
