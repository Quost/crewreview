import { describe, expect, test } from "bun:test";
import { changedSymbols } from "../src/index.ts";

const diff = (path: string, body: string, old = path) => `diff --git a/${old} b/${path}\nindex 1..2 100644\n--- a/${old}\n+++ b/${path}\n${body}`;

describe("functions a change touches", () => {
  test("from the enclosing function git names in the hunk header, and from definitions added or removed", () => {
    const d = [
      diff("lib/iems/devices.ex", "@@ -40,6 +40,9 @@ defmodule Iems.Devices do\n@@ -120,7 +123,12 @@   def update_fields(device, fields, opts) do\n-    {:ok, x}\n+    reread(x)\n+  defp reread(device, attempts) do\n"),
      diff("src/orders/service.ts", "@@ -1,3 +1,4 @@\n+export async function placeOrder(cart: Cart): Promise<Order> {\n+const totalOf = (items: Item[]) => items.length;\n-  if (cart.empty) {\n"),
      diff("pkg/hook/dispatch.go", "@@ -9,2 +9,3 @@ func (s *Service) Dispatch(ctx context.Context) error {\n+\treturn nil\n"),
      diff("src/main/java/Webhook.java", "@@ -5,2 +5,3 @@\n+  public ResponseEntity<Void> configureWebhook(Request r) {\n"),
    ].join("\n");
    expect(changedSymbols(d).map((s) => `${s.name}@${s.path}`)).toEqual([
      "update_fields@lib/iems/devices.ex",
      "reread@lib/iems/devices.ex",
      "placeOrder@src/orders/service.ts",
      "totalOf@src/orders/service.ts",
      "Dispatch@pkg/hook/dispatch.go",
      "configureWebhook@src/main/java/Webhook.java",
    ]);
  });

  test("tests, common names and control flow aren't functions worth following", () => {
    const d = [
      diff("test/devices_test.exs", "@@ -1 +1,2 @@\n+  def setup_device(attrs) do\n"),
      diff("src/a.ts", "@@ -1 +1,3 @@\n+  if (ready) {\n+  render() {\n+function run() {\n"),
    ].join("\n");
    expect(changedSymbols(d)).toEqual([]);
  });

  test("a removed SQL comment isn't a file header, and a deleted file keeps its name", () => {
    const d = [
      diff("db/q.sql", "@@ -1,2 +1 @@\n--- old note\n+select 1;\n"),
      "diff --git a/lib/gone.ex b/lib/gone.ex\ndeleted file mode 100644\n--- a/lib/gone.ex\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-  def legacy_path(x) do\n",
    ].join("\n");
    expect(changedSymbols(d)).toEqual([{ name: "legacy_path", path: "lib/gone.ex" }]);
  });

  test("at most the number asked for", () => {
    const body = Array.from({ length: 50 }, (_, i) => `+  def fun_number_${i}(x) do`).join("\n");
    expect(changedSymbols(diff("lib/a.ex", `@@ -1 +1,50 @@\n${body}\n`), 10)).toHaveLength(10);
  });
});
