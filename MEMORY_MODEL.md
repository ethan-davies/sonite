# TSN Memory Model

TSN aims to be **easy to use**, **TypeScript-like**, and a **compiled native language**. Developers should **not normally think about the stack or heap** — the compiler and runtime handle that automatically.

## Core idea

```text
Value types
    → Stored directly
    → Copied when assigned/passed

Reference types
    → Objects live on the heap
    → Variables hold references to them
    → Automatically managed by the runtime
```

---

## 1. Primitive types → value types

These are values:

```ts
i32
i64
f32
f64
bool
char
```

Example:

```ts
let a: i32 = 10;
let b: i32 = a;

b = 20;
```

Memory conceptually:

```text
a → 10
b → 20
```

Changing `b` does not affect `a`.

Function arguments work the same way — parameters receive a copy:

```ts
function double(x: i32): i32 {
    return x * 2;
}
```

---

## 2. Structs → value types

Structs are **value types**.

```ts
struct Point {
    x: i32;
    y: i32;
}

let a = Point(10, 20);
let b = a;

b.x = 100;
```

Conceptually:

```text
a
┌───────────┐
│ x = 10    │
│ y = 20    │
└───────────┘

b
┌───────────┐
│ x = 100   │
│ y = 20    │
└───────────┘
```

`b` is a copy. Structs are excellent for small data (e.g. `Vector2`) without manual allocate/free.

### Structs can contain references

```ts
struct Person {
    name: string;
}
```

The struct itself is a value, but `name` is a reference to a string object. Copying:

```ts
let a = Person("Ethan");
let b = a;
```

copies the struct's fields, including the reference. The string itself is **not** copied (**shallow copy**):

```text
a ─────┐
       ├──→ "Ethan"
b ─────┘
```

---

## 3. Classes → reference types

Classes are reference types.

```ts
class Person {
    name: string;
}

let a = new Person();
let b = a;

b.name = "Ethan";
```

```text
a ─────┐
       │
       ▼
   Person object
       │
       └── name → "Ethan"
       ▲
       │
b ─────┘
```

`a` and `b` refer to the same object. Mutating through `b` is visible through `a` — the same general behaviour as TypeScript/JavaScript objects.

---

## 4. Arrays → reference types

Arrays are reference types and live on the heap.

```ts
let a = [1, 2, 3];
let b = a;

b.push(4);
```

```text
a ─────┐
       │
       ▼
    [1,2,3,4]
       ▲
       │
b ─────┘
```

`a` sees the change. This matches TypeScript.

---

## 5. Strings → reference types

Strings are heap-backed reference types and are **immutable**.

```ts
let a = "hello";
let b = a;
```

```text
a ─────┐
       ▼
   "hello"
       ▲
       │
b ─────┘
```

You cannot modify characters in place. Operations such as `toUpper()` or `concat()` produce a new string. The runtime APIs (`tsn_str_len`, `tsn_str_concat`, etc.) fit this model.

---

## 6. Maps → reference types

Maps are reference types.

```ts
let a = Map();
let b = a;

b.set("name", "Ethan");
```

Both `a` and `b` refer to the same map:

```text
a ─────┐
       ▼
      Map
       ▲
       │
b ─────┘
```

---

## 7. Closures → reference types

Closures need an environment for captured variables. That environment must outlive the function that created it, so closures are heap-allocated and automatically managed.

```ts
function createCounter() {
    let count = 0;

    return () => {
        count++;
        return count;
    };
}
```

```text
Closure
├── function code
└── environment
      └── count = 0
```

```text
createCounter()
    │
    ▼
Closure object
    │
    └── Environment
           └── count
```

---

## 8. Enums

Simple enums are **value types**, represented internally as an integer/tag (hidden from the developer):

```ts
enum Direction {
    Up,
    Down,
    Left,
    Right
}
```

```text
Up    = 0
Down  = 1
Left  = 2
Right = 3
```

Data-carrying variants (if added later) would behave more like tagged unions and need a separate model.

---

## 9. Interfaces

Interfaces have **no independent runtime storage**. They are primarily compile-time types.

```ts
interface Printable {
    print(): void;
}

struct Number {
    value: i32;

    print(): void {
        // ...
    }
}

let x: Printable = Number(10);
```

The actual object is still a `Number`. The interface does not create a new object.

If dynamic dispatch is needed, the compiler may generate a fat pointer / dispatch structure — an implementation detail:

```text
Printable reference
       │
       ▼
┌─────────────────┐
│ data → Number   │
│ vtable → ...    │
└─────────────────┘
```

---

## 10. Stack vs heap

The developer does not choose. The compiler decides.

### Stack

Short-lived local values where possible:

```ts
function add(a: i32, b: i32): i32 {
    let result = a + b;
    return result;
}
```

```text
Call add()
    │
    ▼
Stack frame
├── a
├── b
└── result
```

When the function returns, the frame disappears.

### Heap

Objects whose lifetime may exceed a function call:

```ts
let person = new Person();

function createPerson(): Person {
    return new Person();
}
```

---

## 11. Key rule for developers

The developer writes:

```ts
let person = new Person();
```

Not:

```text
allocate 32 bytes on heap
track reference count
free object when finished
```

The compiler and runtime handle allocation and reclamation.

---

## 12. Memory management

TSN uses **automatic garbage collection**.

- No manual `free(person)`
- No required `Box<Person>` / `Rc<Person>` for everyday code
- Normal code: `let person = new Person();` — the runtime reclaims when unreachable

---

## 13. GC strategy

**First implementation:** tracing GC, specifically a simple **mark-and-sweep** collector.

```text
Heap
│
├── Person A ← reachable
├── Person B ← unreachable
├── Array A  ← reachable
└── String A ← unreachable
```

Roots include:

```text
Stack
Global variables
Active closures
Runtime roots
```

The collector follows references from roots; unreachable objects are freed. Generational or concurrent GC can come later as optimizations.

---

## 14. References

**Implicit references** for normal programming:

```ts
class Person {}

let a = new Person();
let b = a;
```

No `Person*` or `ref<Person>` required. The compiler knows `Person` is a reference type.

Explicit references/pointers may be added later for low-level work; they are not required for everyday code.

---

## 15. Pointers

Explicit pointers are **out of the initial memory model**.

Systems-level syntax such as `let ptr: *i32` may come later. Normal code stays:

```ts
let x: i32 = 10;
```

not:

```ts
let x: *i32 = ...
```

---

## 16. Summary table

| Type         | Category         | Default storage            |
| ------------ | ---------------- | -------------------------- |
| `i32`, `i64` | Value            | Stack/register             |
| `f32`, `f64` | Value            | Stack/register             |
| `bool`       | Value            | Stack/register             |
| `char`       | Value            | Stack/register             |
| Enum         | Value            | Stack/register             |
| Struct       | Value            | Inline/stack when possible |
| Class        | Reference        | Heap                       |
| Array        | Reference        | Heap                       |
| String       | Reference        | Heap                       |
| Map          | Reference        | Heap                       |
| Closure      | Reference        | Heap                       |
| Interface    | Compile-time only | No independent storage     |

**Stack vs heap is not the same as value vs reference.**

A value-type struct may still be heap-placed when needed. A class *reference* often lives in a stack local while the object lives on the heap:

```text
Stack                 Heap

person ─────────────→ Person object
(reference)           (actual data)
```

### Mental model

```text
                TSN Types
                    │
          ┌─────────┴─────────┐
          │                   │
      Value types        Reference types
          │                   │
     Copy on assign      Reference on assign
          │                   │
     Structs, primitives   Classes, arrays,
     enums                 strings, maps,
                           closures
          │                   │
          └─────────┬─────────┘
                    │
             Compiler decides
             physical storage
                    │
             ┌──────┴──────┐
             │             │
           Stack         Heap
             │             │
       Short-lived      Long-lived
       local data       objects
                           │
                           ▼
                    Automatic GC
```

### Design decisions (canonical)

| Concern | Decision |
| --- | --- |
| Value types | Primitives, enums, structs |
| Reference types | Classes, arrays, strings, maps, closures |
| Interfaces | Compile-time abstractions; runtime dispatch only when necessary |
| Storage | Compiler chooses stack/register vs heap |
| Memory management | Automatic tracing GC (initially mark-and-sweep) |
| References | Implicit for reference types |
| Pointers | Optional future low-level feature |
| Manual `free` | Not part of normal TSN programming |
