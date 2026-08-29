/** Read-only Remote projection of the remote registry for trusted client RPCs. */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { TypertRemoteService, Remote } from '@shres-code/shres-code-typert-protocol';
import { resolveRegistryPath } from "./home.js";
import { loadRegistry } from "./registry.js";
/**
 * Serve the remote registry as the `remoteControl` Remote namespace. The
 * projection is read-only: mutating and connecting must mount as a separate
 * token-gated namespace, because this service is served identically by local
 * and tunneled remotes and cannot enforce the local user's gesture authority.
 * The Gateway maps business throws to its generic wire failure (message
 * without a typed code), so callers render the message as-is; `registry-corrupt`
 * divergence stays loud server-side.
 */
let RemoteControlGateway = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _list_decorators;
    return class RemoteControlGateway extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _list_decorators = [Remote('list')];
            __esDecorate(this, null, _list_decorators, { kind: "method", name: "list", static: false, private: false, access: { has: obj => "list" in obj, get: obj => obj.list }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        constructor(ctx) {
            super(ctx, 'remoteControl');
            __runInitializers(this, _instanceExtraInitializers);
        }
        /**
         * Read the registry file on every call; a missing file is the empty set and
         * never an error, so a fresh installation renders an empty Remote group.
         * @returns Current registry entries in registry order.
         */
        async list() {
            const entries = await loadRegistry(resolveRegistryPath());
            return {
                entries: [...entries.values()].map(entry => ({
                    id: entry.id,
                    target: entry.target,
                    remotePort: entry.remotePort,
                    fingerprint: entry.fingerprint,
                    lastConnectedAt: entry.lastConnectedAt,
                    createdAt: entry.createdAt,
                })),
            };
        }
    };
})();
export { RemoteControlGateway };
export default RemoteControlGateway;
//# sourceMappingURL=gateway.js.map