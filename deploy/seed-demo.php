<?php
/**
 * Demo catalog for a short video. Idempotent.
 * Drafts the timestamped test products and trashes their orders so the
 * shop and list_orders stay short. Re-run safe: demo SKUs and the
 * _urmiai_demo order marker are updated, not duplicated.
 */
require "/var/www/html/wp-load.php";

$products = [
    ["sku" => "DEMO-MUG", "name" => "Stoneware Mug", "price" => "18.00", "stock" => 24, "desc" => "Everyday mug, 12 oz, speckled grey."],
    ["sku" => "DEMO-KETTLE", "name" => "Pour-Over Kettle", "price" => "42.00", "stock" => 8, "desc" => "Gooseneck kettle for a steady pour."],
    ["sku" => "DEMO-NOTE", "name" => "Linen Notebook", "price" => "14.00", "stock" => 30, "desc" => "Blank pages, linen cover."],
    ["sku" => "DEMO-THROW", "name" => "Wool Throw", "price" => "68.00", "stock" => 6, "desc" => "Charcoal throw for the sofa."],
    ["sku" => "DEMO-LAMP", "name" => "Brass Desk Lamp", "price" => "54.00", "stock" => 10, "desc" => "Small lamp, warm bulb included."],
];

$drafted = 0;
foreach (wc_get_products(["status" => "publish", "limit" => -1]) as $product) {
    $sku = (string) $product->get_sku();
    if (str_starts_with($sku, "DEMO-")) {
        continue;
    }
    $product->set_status("draft");
    $product->save();
    $drafted++;
}

$saved = [];
foreach ($products as $item) {
    $found = wc_get_products(["sku" => $item["sku"], "limit" => 1, "status" => ["publish", "draft", "private"]]);
    $product = $found ? $found[0] : new WC_Product_Simple();
    $product->set_name($item["name"]);
    $product->set_status("publish");
    $product->set_catalog_visibility("visible");
    $product->set_regular_price($item["price"]);
    $product->set_description($item["desc"]);
    $product->set_sku($item["sku"]);
    $product->set_manage_stock(true);
    $product->set_stock_quantity($item["stock"]);
    $product->set_stock_status("instock");
    $product->save();
    $saved[] = ["id" => $product->get_id(), "name" => $item["name"], "price" => $item["price"]];
}

$trashed = 0;
$orderIds = wc_get_orders([
    "limit" => -1,
    "return" => "ids",
    "status" => ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"],
]);
foreach ($orderIds as $orderId) {
    $order = wc_get_order($orderId);
    if (!$order || $order->get_meta("_urmiai_demo")) {
        continue;
    }
    $order->delete(false);
    $trashed++;
}

$orders = [
    ["key" => "maya", "status" => "completed", "first" => "Maya", "last" => "Chen", "email" => "maya.chen@example.com", "lines" => [["sku" => "DEMO-MUG", "qty" => 1]]],
    ["key" => "luis", "status" => "processing", "first" => "Luis", "last" => "Ortega", "email" => "luis.ortega@example.com", "lines" => [["sku" => "DEMO-KETTLE", "qty" => 1]]],
    ["key" => "asha", "status" => "processing", "first" => "Asha", "last" => "Reddy", "email" => "asha.reddy@example.com", "lines" => [["sku" => "DEMO-NOTE", "qty" => 2]]],
];

$savedOrders = [];
foreach ($orders as $spec) {
    $existing = wc_get_orders([
        "limit" => 1,
        "status" => "any",
        "meta_key" => "_urmiai_demo",
        "meta_value" => $spec["key"],
    ]);
    $order = $existing ? $existing[0] : wc_create_order();
    if (!$existing) {
        foreach ($spec["lines"] as $line) {
            $productId = wc_get_product_id_by_sku($line["sku"]);
            $order->add_product(wc_get_product($productId), $line["qty"]);
        }
        $order->update_meta_data("_urmiai_demo", $spec["key"]);
    }
    $order->set_billing_first_name($spec["first"]);
    $order->set_billing_last_name($spec["last"]);
    $order->set_billing_email($spec["email"]);
    $order->set_billing_address_1("1 Demo Street");
    $order->set_billing_city("Oakland");
    $order->set_billing_state("CA");
    $order->set_billing_postcode("94612");
    $order->set_billing_country("US");
    $order->set_payment_method("cod");
    $order->set_payment_method_title("Cash on delivery");
    $order->calculate_totals();
    $order->set_status($spec["status"]);
    $order->save();
    $savedOrders[] = [
        "id" => $order->get_id(),
        "status" => $spec["status"],
        "who" => $spec["first"] . " " . $spec["last"],
        "email" => $spec["email"],
        "total" => $order->get_total(),
    ];
}

echo json_encode([
    "draftedProducts" => $drafted,
    "trashedOrders" => $trashed,
    "products" => $saved,
    "orders" => $savedOrders,
], JSON_PRETTY_PRINT), "\n";
