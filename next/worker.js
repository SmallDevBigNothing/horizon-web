// One of the game's threads (horizon-os's `workers`): instantiates the game's
// module on the page's shared memory, then runs the thread it was handed.
import init, { horizon_worker_entry } from "./pkg/horizon-client.js?v=6";

self.onmessage = async ({ data }) => {
    self.onmessage = null;
    try {
        await init({ module_or_path: data.module, memory: data.memory, thread_stack_size: data.stack });
        horizon_worker_entry(data.ptr);
    } catch (err) {
        console.error("Horizon worker init exception:", err);
        throw err;
    }
    self.close();
};
