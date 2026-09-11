# `src/types/`

This folder contains TypeScript interfaces for every entity in the database schema.

---

## What is a TypeScript interface?

An interface is a **contract that describes the shape of an object**. It tells the TypeScript compiler what fields an object has and what type each field is. If you try to use an object that doesn't match the contract, the compiler flags it as an error before you ever run the code.

```ts
interface User {
  id: string;
  email: string;
  role: UserRole;
}

const user: User = { id: '123', email: 'a@b.com', role: UserRole.photographer };
// ✅ compiles

const bad: User = { id: '123' };
// ❌ TypeScript error: missing 'email' and 'role'
```

The key point: **interfaces have no runtime existence**. They are erased during compilation. They are purely a compile-time safety net.

---

## Interfaces vs. `type` vs. `class`

| | Interface | `type` alias | `class` |
|---|---|---|---|
| Describes object shape | ✅ | ✅ | ✅ |
| Can be extended/merged | ✅ (with `extends`) | Limited | ✅ (with `extends`) |
| Exists at runtime | ❌ | ❌ | ✅ |
| Can be instantiated (`new`) | ❌ | ❌ | ✅ |

**Rule of thumb:** use `interface` for object shapes (like database rows), use `type` for unions and computed types, use `class` only when you need runtime behaviour (methods, instantiation).

---

## Where do these come from?

Each interface mirrors one table in the PostgreSQL schema. The fields, types, and nullability (`| null`) map directly to the SQL column definitions. They are two representations of the same thing — if you add a column in a migration, you add the field here too.

When you add a field here, the compiler will flag every place in the codebase that constructs that type, prompting you to handle the new field everywhere. This is the main value: **changes propagate as compile errors, not runtime surprises**.

---

## Enums

Enums give a name to a fixed set of string values:

```ts
enum UserRole {
  photographer = 'photographer',
  client = 'client',
}
```

Why use them instead of plain strings?

- `UserRole.photographer` — compiler catches typos at build time
- `"photographr"` — fails silently at runtime

These match the `ENUM` types defined in the PostgreSQL migrations exactly.

---

## Nullable fields

A field typed `string | null` means the database column is nullable (`NULL` allowed). A field typed just `string` maps to a `NOT NULL` column. This matters in your query functions — nullable fields require null checks before you use them.

---

## Useful utility types

TypeScript has built-in utility types you will reach for in your route handlers:

**`Partial<T>`** — makes all fields optional. Useful for PATCH request bodies where the client only sends the fields they want to update:
```ts
type UpdatePhotographerBody = Partial<Photographer>;
// all fields become optional
```

**`Pick<T, 'field1' | 'field2'>`** — creates a new type with only the listed fields. Useful for response shapes where you only want to expose certain fields to the client:
```ts
type PublicPhotographer = Pick<Photographer, 'businessName' | 'bio' | 'profilePhotoUrl'>;
```

**`Omit<T, 'field'>`** — opposite of Pick; excludes listed fields. Useful for create bodies where the DB generates the `id`:
```ts
type CreateUserBody = Omit<User, 'id' | 'joinedAt'>;
```
