import axios, { AxiosInstance } from "axios";

/**
 * Thin wrapper around the WooCommerce REST API (v3).
 *
 * Why REST API and not WP-CLI / direct DB access:
 * - It's the official, versioned, documented WooCommerce interface.
 * - Auth is just a consumer key/secret pair issued once at provisioning time
 *   (see the wp-init Job in the Helm chart) — no shell access into the
 *   WordPress pod required, which keeps this server's RBAC footprint at zero
 *   (it doesn't need `exec` into any pod, just an HTTP egress).
 * - It's stable across WordPress/WooCommerce versions, unlike scraping
 *   wp-cli output or querying the MariaDB schema directly.
 */
export interface WooCommerceConfig {
  baseUrl: string; // e.g. http://wordpress.store-default.svc.cluster.local
  consumerKey: string;
  consumerSecret: string;
}

export class WooCommerceClient {
  private readonly http: AxiosInstance;

  constructor(private readonly config: WooCommerceConfig) {
    // WooCommerce rejects HTTP Basic auth unless the site is HTTPS, and the
    // WordPress Apache image also drops the Authorization header. Query
    // credentials are the supported fallback for an in-cluster HTTP store.
    this.http = axios.create({
      baseURL: `${config.baseUrl.replace(/\/$/, "")}/wp-json/wc/v3`,
      timeout: 10_000,
      params: {
        consumer_key: config.consumerKey,
        consumer_secret: config.consumerSecret,
      },
    });
  }

  async listProducts(params: { search?: string; perPage?: number; page?: number }) {
    const { data } = await this.http.get("/products", {
      params: {
        search: params.search,
        per_page: params.perPage ?? 20,
        page: params.page ?? 1,
      },
    });
    return data;
  }

  async createProduct(input: {
    name: string;
    regularPrice: string;
    description?: string;
    sku?: string;
    stockQuantity?: number;
  }) {
    const { data } = await this.http.post("/products", {
      name: input.name,
      type: "simple",
      regular_price: input.regularPrice,
      description: input.description,
      sku: input.sku,
      manage_stock: input.stockQuantity !== undefined,
      stock_quantity: input.stockQuantity,
    });
    return data;
  }

  async listOrders(params: { after?: string; status?: string; perPage?: number }) {
    const { data } = await this.http.get("/orders", {
      params: {
        after: params.after,
        status: params.status,
        per_page: params.perPage ?? 20,
        orderby: "date",
        order: "desc",
      },
    });
    return data;
  }

  async getOrder(orderId: number) {
    const { data } = await this.http.get(`/orders/${orderId}`);
    return data;
  }

  async updateOrderStatus(orderId: number, status: string) {
    const { data } = await this.http.put(`/orders/${orderId}`, { status });
    return data;
  }
}
