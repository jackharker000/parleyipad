import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { installNativeBridge } from "./lib/native-bridge";

// Inside the Capacitor shell this patches fetch so server-fn calls reach the
// hosted deploy; must run before anything can fire one. No-op on web/SSR.
installNativeBridge();

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
