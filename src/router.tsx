import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent
} from '@tanstack/react-router';
import { appEnv } from '@/app/env';
import { AdminShell } from '@/components/layout/AdminShell';
import { ConfigurationScreen } from '@/components/layout/ConfigurationScreen';

function RootComponent() {
  if (appEnv.mode === 'unconfigured') return <ConfigurationScreen />;
  return <Outlet />;
}

const rootRoute = createRootRoute({
  component: RootComponent,
  notFoundComponent: lazyRouteComponent(() => import('@/pages/NotFoundPage'))
});

const storefrontRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: lazyRouteComponent(() => import('@/pages/public/StorefrontPage'))
});

const productRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/producto/$slug',
  component: lazyRouteComponent(() => import('@/pages/public/ProductPage'))
});

const cartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/carrito',
  component: lazyRouteComponent(() => import('@/pages/public/CartPage'))
});

const checkoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/checkout',
  component: lazyRouteComponent(() => import('@/pages/public/CheckoutPage'))
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ingresar',
  component: lazyRouteComponent(() => import('@/pages/LoginPage'))
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  component: AdminShell
});

const dashboardRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  component: lazyRouteComponent(() => import('@/pages/admin/DashboardPage'))
});

const ordersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/pedidos',
  component: lazyRouteComponent(() => import('@/pages/admin/OrdersPage'))
});

const importOrderRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/pedidos/importar',
  component: lazyRouteComponent(() => import('@/pages/admin/ImportOrderPage'))
});

const productsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/productos',
  component: lazyRouteComponent(() => import('@/pages/admin/ProductsPage'))
});

const inventoryRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/inventario',
  component: lazyRouteComponent(() => import('@/pages/admin/InventoryPage'))
});

const stockRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/stock',
  component: lazyRouteComponent(() => import('@/pages/admin/InventoryPage'))
});

const movementsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/movimientos',
  component: lazyRouteComponent(() => import('@/pages/admin/InventoryPage'))
});

const customersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/clientes',
  component: lazyRouteComponent(() => import('@/pages/admin/CustomersPage'))
});

const purchasesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/compras',
  component: lazyRouteComponent(() => import('@/pages/admin/InventoryPage'))
});

const salesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/ventas',
  component: lazyRouteComponent(() => import('@/pages/admin/SalesPage'))
});

const analyticsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/analiticas',
  component: lazyRouteComponent(() => import('@/pages/admin/SalesPage'))
});

const aiRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/ia',
  component: lazyRouteComponent(() => import('@/pages/admin/AiPage'))
});

const exportRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/exportar',
  component: lazyRouteComponent(() => import('@/pages/admin/ExportPage'))
});

const settingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/configuracion',
  component: lazyRouteComponent(() => import('@/pages/admin/SettingsPage'))
});

const usersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/usuarios',
  component: lazyRouteComponent(() => import('@/pages/admin/UsersPage'))
});

const adminTree = adminRoute.addChildren([
  dashboardRoute,
  ordersRoute,
  importOrderRoute,
  productsRoute,
  inventoryRoute,
  stockRoute,
  movementsRoute,
  customersRoute,
  purchasesRoute,
  salesRoute,
  analyticsRoute,
  aiRoute,
  exportRoute,
  settingsRoute,
  usersRoute
]);

const routeTree = rootRoute.addChildren([
  storefrontRoute,
  productRoute,
  cartRoute,
  checkoutRoute,
  loginRoute,
  adminTree
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 30_000,
  scrollRestoration: true
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
