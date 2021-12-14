import { Entity } from 'dexie';
import type { TodoDB } from './TodoDB';
import { getTiedRealmId } from 'dexie-cloud-addon';

/** Since there are some actions associated with
 * this entity (share(), unshare() etc) it can be
 * nice to use a mapped class here.
 *
 * We could equally well have declared TodoList as an interface
 * and write helper functions on the side.
 *
 * The Entity base class tells dexie to inject db as a prop this.db.
 * This is to avoid recursive dependencies when you need to access
 * db from within a method.
 */
export class TodoList extends Entity<TodoDB> {
  //
  // Persisted Properties
  //

  id!: string;
  realmId!: string;
  owner!: string;
  title!: string;

  //
  // Methods
  //

  isSharable() {
    return this.realmId === getTiedRealmId(this.id);
  }

  async makeSharable() {
    const currentRealmId = this.realmId;
    const newRealmId = getTiedRealmId(this.id);
    const { db } = this;

    await this.db.transaction(
      'rw',
      [db.todoLists, db.todoItems, db.realms],
      async () => {
        // Create tied realm
        // We use put() here in case same user does this on
        // two offline devices to add different members - we don't
        // want one of the actions to fail - we want both to succeed
        // and add both members
        await db.realms.put({
          realmId: newRealmId,
          name: this.title,
        });

        // "Realmify entity" (setting realmId equals own id will make it become a Realm)
        await db.todoLists.update(this.id!, { realmId: newRealmId });
        // Move all todo items into the new realm consistently (modify() is consistent across sync peers)
        await db.todoItems
          .where({
            realmId: currentRealmId,
            todoListId: this.id,
          })
          .modify({ realmId: newRealmId });
      }
    );
    return newRealmId;
  }

  async makePrivate() {
    const { db, realmId: oldRealmId } = this;
    await db.transaction(
      'rw',
      [db.todoLists, db.todoItems, db.members, db.realms],
      async () => {
        // Move todoItems out of the realm in a sync-consistent operation:
        await db.todoItems
          .where({
            realmId: oldRealmId,
            todoListId: this.id,
          })
          .modify({ realmId: db.cloud.currentUserId });

        // Move the todoList back into your private realm:
        await db.todoLists.update(this.id, {
          realmId: this.db.cloud.currentUserId,
        });

        // Remove all access (Collection.delete() is a sync-consistent operation)
        await db.members.where('realmId').equals(oldRealmId).delete();
        // Delete tied realm
        await db.realms.delete(this.realmId);
      }
    );
  }

  async shareWith(name: string, email: string, sendEmail: boolean) {
    const { db } = this;
    await db.transaction(
      'rw',
      [db.members, db.todoLists, db.todoItems, db.realms],
      async () => {
        let realmId = this.realmId;
        if (!this.isSharable()) {
          realmId = await this.makeSharable();
        }

        // Add given name and email as a member with full permissions
        await this.db.members.add({
          realmId,
          name,
          email,
          invite: sendEmail,
          permissions: { add: ['todoItems'], update: { todoItems: ['done'] } },
        });
      }
    );
  }

  async unshareWith(email: string) {
    const { db } = this;
    await db.transaction(
      'rw',
      [db.todoLists, db.todoItems, db.members, db.realms],
      async () => {
        await db.members
          .where({
            realmId: this.realmId,
            email,
          })
          .delete();
        const numMembers = await db.members
          .where({ realmId: this.realmId })
          .count();
        if (numMembers <= 1) {
          // Only our own member left.
          await this.makePrivate();
        }
      }
    );
  }

  async delete() {
    const { db } = this;
    await db.transaction(
      'rw',
      [db.todoLists, db.todoItems, db.members, db.realms],
      () => {
        // Delete todo items
        db.todoItems
          .where({
            todoListId: this.id,
          })
          .delete();

        // Delete the list
        db.todoLists.delete(this.id!);

        // Delete any tied realm and related access:
        const tiedRealmId = getTiedRealmId(this.id);
        db.members.where({ realmId: tiedRealmId }).delete();
        db.realms.delete(tiedRealmId);
      }
    );
  }
}