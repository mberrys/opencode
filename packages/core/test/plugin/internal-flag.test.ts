import { describe, expect, spyOn } from "bun:test"
import { Duration, Effect, Layer, LayerMap, Stream } from "effect"
import { App } from "@opencode/core/app"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Flag } from "@opencode/core/flag"
import { Instance } from "@opencode/core/instance"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Plugin } from "@opencode/core/plugin"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { Tool } from "@opencode/core/tool"
import { TodoTool } from "@opencode/core/tool/plugin/todo"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import ResearchPlugin from "@opencode/research"
import { Bus } from "../../src/bus"
import { Database } from "../../src/database/database"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { toolDefinitions } from "../lib/tool"

const unexpected = (pkg: string) =>
  Effect.fail(new Npm.InstallFailedError({ add: [pkg], dir: "", cause: new Error(`Unexpected Npm call: ${pkg}`) }))

const instances = (channel: string) =>
  Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const map = yield* LayerMap.make(
        (ref: Location.Ref) => Instance.layer(ref, { discovery: false, replacements: bindings }),
        { idleTimeToLive: Duration.infinity },
      )
      const bindings: LayerNode.Replacements = [
        App.node.replace(App.configured({ channel })),
        Global.node.replace(tempGlobalLayer),
        offlineModels,
        ConfigPluginSource.node.replace(
          Layer.succeed(
            ConfigPluginSource.Service,
            ConfigPluginSource.Service.of({ operations: () => Effect.succeed([]), changes: () => Stream.never }),
          ),
        ),
        Npm.node.replace(
          Layer.succeed(
            Npm.Service,
            Npm.Service.of({
              add: unexpected,
              resolve: (name) => Effect.succeed({ directory: "", name }),
              check: () => Effect.succeed(false),
              update: unexpected,
              follows: () => Effect.succeed(false),
              reject: () => Effect.succeed(false),
              which: () => Effect.undefined,
            }),
          ),
        ),
        LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
        Instance.node.replace(
          Layer.succeed(Instance.Service, { provide: (session) => Effect.provide(map.get(session.location)) }),
        ),
      ]
      return map
    }),
  )

const server = (channel: string) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      LocationServiceMap.node.replace(instances(channel)),
    ]),
  )

const it = server("dev")
const release = server("latest")

const activate = Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const locations = yield* LocationServiceMap.Service
  yield* Effect.gen(function* () {
    yield* (yield* Plugin.Service).awaitActivation
  }).pipe(
    Effect.scoped,
    Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
  )
})

describe("PluginInternal flags", () => {
  it.live("turns flagged built-in tools on for a dev-channel server with no config while keeping todo off", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      const { registered, direct } = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        const tools = yield* Tool.Service
        return {
          registered: (yield* tools.list()).map((tool) => tool.id),
          direct: (yield* toolDefinitions(tools)).map((definition) => definition.name),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )

      expect(registered).toContain("opencode_artifact_create")
      expect(registered).toContain("shell")
      expect(registered).not.toContain(TodoTool.name)
      expect(direct).not.toContain("shell")
    }).pipe(Effect.provideService(Flag.Overrides, undefined)),
  )

  it.live("loads the research plugin when the research flag is on", () =>
    Effect.gen(function* () {
      const load = spyOn(ResearchPlugin, "effect")
      yield* activate
      expect(load).toHaveBeenCalledTimes(1)
      load.mockRestore()
    }),
  )

  release.live("leaves the research plugin unloaded when the research flag is off", () =>
    Effect.gen(function* () {
      const load = spyOn(ResearchPlugin, "effect")
      yield* activate
      expect(load).not.toHaveBeenCalled()
      load.mockRestore()
    }),
  )
})
