<?php
$path = "/var/www/html/wp-config.php";
$source = file_get_contents($path);
if (!str_contains($source, "urmiai-allow-http-rest-keys")) {
    $line = "\n// urmiai-allow-http-rest-keys\nif (isset(\$_GET[\"consumer_key\"])) { \$_SERVER[\"HTTPS\"] = \"on\"; }\n";
    $source = preg_replace("/<\\?php/", "<?php" . $line, $source, 1);
    file_put_contents($path, $source);
    echo "inserted\n";
} else {
    echo "already\n";
}
