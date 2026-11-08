import { describe, expect, test } from "bun:test"

import { withJsRuntime } from "@/server/media/yt-dlp/runner"

describe("withJsRuntime", () => {
  test("prepends the node JS runtime", () => {
    expect(
      withJsRuntime(["--dump-single-json", "https://example.com/a"]),
    ).toEqual([
      "--js-runtimes",
      "node",
      "--dump-single-json",
      "https://example.com/a",
    ])
  })

  test("does not duplicate an explicit runtime", () => {
    const args = ["--js-runtimes", "deno", "--dump-single-json"]
    expect(withJsRuntime(args)).toBe(args)
  })

  test("does not mutate the input", () => {
    const args = ["--version"]
    withJsRuntime(args)
    expect(args).toEqual(["--version"])
  })
})
