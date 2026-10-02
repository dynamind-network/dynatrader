/**
 * Base class for tools with persistent configuration storage
 */

import { BaseTool } from './base-tool.js';
import type { ToolResult } from '../core/types.js';

export interface StorageService<T> {
  get(key: string): T[];
  set(key: string, items: T[]): void;
  add(key: string, item: T): void;
  remove(key: string, predicate: (item: T) => boolean): void;
  update(key: string, updater: (items: T[]) => T[]): void;
  clear(key: string): void;
}

/**
 * Abstract base class for tools that manage persistent configuration
 */
export abstract class ConfigurableTool<T> extends BaseTool {
  protected abstract storage: StorageService<T>;
  protected abstract storageKey: string;

  /**
   * Add item to configuration
   */
  protected addItem(item: T): void {
    try {
      this.storage.add(this.storageKey, item);
    } catch (err) {
      console.error(`Failed to add item: ${err}`);
    }
  }

  /**
   * Remove items matching predicate
   */
  protected removeItem(predicate: (item: T) => boolean): number {
    try {
      const before = this.getAll().length;
      this.storage.remove(this.storageKey, predicate);
      const after = this.getAll().length;
      return before - after;
    } catch (err) {
      console.error(`Failed to remove item: ${err}`);
      return 0;
    }
  }

  /**
   * Update configuration with transformation function
   */
  protected updateItem(updater: (items: T[]) => T[]): void {
    try {
      this.storage.update(this.storageKey, updater);
    } catch (err) {
      console.error(`Failed to update item: ${err}`);
    }
  }

  /**
   * Get all items from configuration
   */
  protected getAll(): T[] {
    try {
      return this.storage.get(this.storageKey);
    } catch (err) {
      console.error(`Failed to get items: ${err}`);
      return [];
    }
  }

  /**
   * Find single item matching predicate
   */
  protected findItem(predicate: (item: T) => boolean): T | null {
    const items = this.getAll();
    return items.find(predicate) || null;
  }

  /**
   * Filter items matching predicate
   */
  protected filterItems(predicate: (item: T) => boolean): T[] {
    return this.getAll().filter(predicate);
  }

  /**
   * Clear all configuration
   */
  protected clearAll(): void {
    try {
      this.storage.clear(this.storageKey);
    } catch (err) {
      console.error(`Failed to clear storage: ${err}`);
    }
  }

  /**
   * Get count of items
   */
  protected getCount(): number {
    return this.getAll().length;
  }

  /**
   * Check if item exists
   */
  protected exists(predicate: (item: T) => boolean): boolean {
    return this.getAll().some(predicate);
  }

  /**
   * Format items for display
   */
  protected formatItems(items: T[]): string {
    return JSON.stringify(items, null, 2);
  }

  /**
   * Return success with item count
   */
  protected successWithCount(message: string): ToolResult {
    const count = this.getCount();
    return this.success(`${message} (${count} total)`);
  }
}

