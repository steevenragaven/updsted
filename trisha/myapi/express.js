const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Validate environment variables
const requiredEnvVars = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE', 'DB_PORT'];
requiredEnvVars.forEach((varName) => {
    if (!process.env[varName]) {
        console.error(`Error: Environment variable ${varName} is not set.`);
        process.exit(1);
    }
});

// Database connection
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
});

// Middleware
app.use(express.json());
app.use(cors({
    origin: '*' // for development, specify origins or use '*' for all
}));
app.use(morgan('dev'));

app.post('/register', async (req, res) => {
    const { username, password, email, fullname, address, postcode, mobilenumber, telephonenumber } = req.body;

    try {
        const client = await pool.connect();
        
        // Check for duplicate username
        const usernameCheck = await client.query('SELECT * FROM users WHERE username = $1', [username]);
        if (usernameCheck.rows.length > 0) {
            client.release();
            res.status(400).json({ message: 'Username already exists' });
            return;
        }
        
        // Check for duplicate email
        const emailCheck = await client.query('SELECT * FROM userdetails WHERE email = $1', [email]);
        if (emailCheck.rows.length > 0) {
            client.release();
            res.status(400).json({ message: 'Email already exists' });
            return;
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const insertUser = await client.query(
            'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING userid',
            [username, hashedPassword]
        );

        const userId = insertUser.rows[0].userid;

        await client.query(
            'INSERT INTO userdetails (userid, email, fullname, address, postcode, mobilenumber, telephonenumber) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [userId, email, fullname, address, postcode, mobilenumber, telephonenumber]
        );

        client.release();
        res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/check-email', async (req, res) => {
    const { email } = req.query;

    try {
        const client = await pool.connect();
        const emailCheck = await client.query('SELECT * FROM userdetails WHERE email = $1', [email]);

        client.release();

        if (emailCheck.rows.length > 0) {
            res.status(200).json({ exists: true });
        } else {
            res.status(200).json({ exists: false });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/cart-total', async (req, res) => {
    const { userId } = req.query;

    try {
        const client = await pool.connect();

        // Get cart items for the user
        const cartItemsResult = await client.query('SELECT * FROM cart_items WHERE user_id = $1', [userId]);
        if (cartItemsResult.rows.length === 0) {
            client.release();
            return res.status(400).json({ message: 'No items in cart' });
        }

        const cartItems = cartItemsResult.rows;

        // Calculate the total amount and delivery fee
        let totalAmount = 0;
        const uniqueStores = new Set();
        for (const item of cartItems) {
            const product = await client.query('SELECT * FROM products WHERE productid = $1', [item.product_id]);
            totalAmount += item.quantity * product.rows[0].price;
            uniqueStores.add(item.shop);
        }

        const deliveryFee = uniqueStores.size * 150;
        totalAmount += deliveryFee;

        client.release();
        res.status(200).json({ totalAmount });
    } catch (error) {
        console.error('Error calculating total:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const client = await pool.connect();
        const userCheck = await client.query('SELECT * FROM users WHERE username = $1', [username]);

        if (userCheck.rows.length === 0) {
            res.status(400).json({ message: 'Invalid username or password' });
            return;
        }

        const user = userCheck.rows[0];
        const isValidPassword = await bcrypt.compare(password, user.password);

        if (!isValidPassword) {
            res.status(400).json({ message: 'Invalid username or password' });
            return;
        }

        const token = jwt.sign({ userid: user.userid, username: user.username }, 'your_jwt_secret', { expiresIn: '1h' });

        client.release();
        res.status(200).json({ token });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/check-username', async (req, res) => {
    const { username } = req.query;

    try {
        const client = await pool.connect();
        const userCheck = await client.query('SELECT * FROM users WHERE username = $1', [username]);

        client.release();

        if (userCheck.rows.length > 0) {
            res.status(200).json({ exists: true });
        } else {
            res.status(200).json({ exists: false });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Categories endpoints
app.get('/categories', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM categories');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/cart', async (req, res) => {
    const { userId } = req.query;

    try {
        const client = await pool.connect();

        // Get cart items for the user
        const cartItemsResult = await client.query(`
            SELECT
                ci.user_id,
                ci.product_id,
                ci.quantity,
                ci.shop,
                p.name,
                p.price,
                p.productimage
            FROM
                cart_items ci
            JOIN
                products p
            ON
                ci.product_id = p.productid
            WHERE
                ci.user_id = $1
        `, [userId]);

        if (cartItemsResult.rows.length === 0) {
            client.release();
            return res.status(200).json([]); // Return an empty array instead of 404
        }

        // Group items by shop
        const cartData = cartItemsResult.rows.reduce((acc, item) => {
            if (!acc[item.shop]) {
                acc[item.shop] = {
                    shop: item.shop,
                    items: [],
                    summary: {
                        subtotal: 0,
                        discounts: 0,
                        delivery_fee: 150, // Fixed delivery fee for each shop
                        total: 0
                    }
                };
            }
            const itemTotal = item.price * item.quantity;
            acc[item.shop].items.push({
                product_id: item.product_id,
                name: item.name,
                price: item.price,
                quantity: item.quantity,
                shop: item.shop
            });
            acc[item.shop].summary.subtotal += itemTotal;
            acc[item.shop].summary.total = acc[item.shop].summary.subtotal + acc[item.shop].summary.delivery_fee - acc[item.shop].summary.discounts;
            return acc;
        }, {});

        client.release();
        res.status(200).json(Object.values(cartData));
    } catch (error) {
        console.error('Error fetching cart data:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.post('/cart', async (req, res) => {
    const { userId, productId, quantity, shop } = req.body;

    try {
        const client = await pool.connect();

        // Check product stock
        const product = await client.query('SELECT * FROM products WHERE productid = $1', [productId]);
        if (product.rows.length === 0 || product.rows[0].stockquantity < quantity) {
            res.status(400).json({ message: 'Product out of stock' });
            return;
        }

        // Add item to cart
        await client.query(
            'INSERT INTO cart_items (user_id, product_id, quantity, shop) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, product_id, shop) DO UPDATE SET quantity = cart_items.quantity + $3',
            [userId, productId, quantity, shop]
        );

        client.release();
        res.status(200).json({ message: 'Item added to cart' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.put('/cart', async (req, res) => {
    const { userId, productId, quantity, shop } = req.body;

    try {
        const client = await pool.connect();

        // Check product stock
        const product = await client.query('SELECT * FROM products WHERE productid = $1', [productId]);
        if (product.rows.length === 0 || product.rows[0].stockquantity < quantity) {
            res.status(400).json({ message: 'Product out of stock' });
            return;
        }

        // Update item quantity in cart
        await client.query(
            'UPDATE cart_items SET quantity = $3 WHERE user_id = $1 AND product_id = $2 AND shop = $4',
            [userId, productId, quantity, shop]
        );

        client.release();
        res.status(200).json({ message: 'Cart item updated' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.delete('/cart', async (req, res) => {
    const { userId, productId, shop } = req.body;

    try {
        const client = await pool.connect();

        // Remove item from cart
        const deleteResult = await client.query(
            'DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2 AND shop = $3 RETURNING *',
            [userId, productId, shop]
        );

        client.release();

        if (deleteResult.rowCount === 0) {
            res.status(404).json({ message: 'Item not found in cart' });
            return;
        }

        res.status(200).json({ message: 'Item removed from cart' });
    } catch (error) {
        console.error('Error removing item from cart:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/products/:categoryid', async (req, res) => {
    const { categoryid } = req.params;
    try {
        const result = await pool.query('SELECT * FROM products WHERE categoryid = $1', [categoryid]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/user', async (req, res) => {
    const { userId, cartItems, paymentMethodId, action } = req.body;

    if (!userId || !Array.isArray(cartItems) || cartItems.length === 0 || !paymentMethodId || !action) {
        console.log('Invalid payload received:', req.body);
        return res.status(400).json({ message: 'Invalid payload' });
    }

    let client;
    try {
        client = await pool.connect();

        // Calculate the total amount
        let totalAmount = 0;
        const cartItemsWithPrices = [];

        for (const item of cartItems) {
            const productResult = await client.query('SELECT * FROM products WHERE productid = $1', [item.productId]);
            const product = productResult.rows[0];

            if (!product || product.stockquantity < item.quantity) {
                client.release();
                return res.status(400).json({ message: 'Some items are out of stock' });
            }

            const itemTotal = item.quantity * product.price;
            totalAmount += itemTotal;

            cartItemsWithPrices.push({
                ...item,
                price: product.price,
            });
        }

        // Create payment intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: totalAmount * 100, // Amount in cents
            currency: 'usd',
            payment_method: paymentMethodId,
            confirm: true,
        });

        if (paymentIntent.status !== 'succeeded') {
            return res.status(400).json({ message: 'Payment failed' });
        }

        // Create order
        const orderResult = await client.query(
            'INSERT INTO orders (userid, totalprice, status, action) VALUES ($1, $2, $3, $4) RETURNING orderid',
            [userId, totalAmount, 'Pending', action]
        );

        const orderId = orderResult.rows[0].orderid;

        // Insert order items
        for (const item of cartItemsWithPrices) {
            await client.query(
                'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)',
                [orderId, item.productId, item.quantity, item.price]
            );

            // Update product stock
            await client.query(
                'UPDATE products SET stockquantity = stockquantity - $1 WHERE productid = $2',
                [item.quantity, item.productId]
            );
        }

        // Clear cart
        await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);

        client.release();
        res.status(200).json({ message: 'Order placed successfully', orderId });
    } catch (error) {
        if (client) client.release();
        console.error('Error completing order:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/api/users/:userid', async (req, res) => {
    const { userid } = req.params;
    try {
        const user = await pool.query('SELECT * FROM public.users WHERE userid = $1', [userid]);
        const userDetails = await pool.query('SELECT * FROM public.userdetails WHERE userid = $1', [userid]);
        if (user.rows.length > 0 && userDetails.rows.length > 0) {
            res.json({ user: user.rows[0], userDetails: userDetails.rows[0] });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/orders/:userid', async (req, res) => {
    const { userid } = req.params;
    try {
        const ordersResult = await pool.query(
            'SELECT orderid, totalprice, orderdate, status, ref FROM public.orders WHERE userid = $1',
            [userid]
        );

        const orders = ordersResult.rows;
        for (let order of orders) {
            const orderDetailsResult = await pool.query(
                'SELECT productid, quantity, priceatorder FROM public.orderdetails WHERE orderid = $1',
                [order.orderid]
            );
            order.details = orderDetailsResult.rows;
        }

        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/orders/:userid/:orderid', async (req, res) => {
    const { userid, orderid } = req.params;
    try {
        const orderResult = await pool.query(
            'SELECT orderid, totalprice, orderdate, status, ref FROM public.orders WHERE userid = $1 AND orderid = $2',
            [userid, orderid]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const order = orderResult.rows[0];
        const orderDetailsResult = await pool.query(
            'SELECT productid, quantity, priceatorder FROM public.orderdetails WHERE orderid = $1',
            [order.orderid]
        );

        order.details = orderDetailsResult.rows;

        res.json(order);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


const axios = require('axios');

app.post('/checkout', async (req, res) => {
    const { userId, cartItems, paymentMethodId, action } = req.body;

    console.log('Received request at /checkout endpoint');
    console.log('Request body:', req.body);

    if (!userId || !Array.isArray(cartItems) || cartItems.length === 0 || !paymentMethodId || !action) {
        console.log('Invalid payload:', {
            userId,
            cartItems,
            paymentMethodId,
            action,
        });
        return res.status(400).json({ message: 'Invalid payload' });
    }

    let client;
    try {
        client = await pool.connect();

        // Calculate the total amount
        let totalAmount = 0;
        const cartItemsWithPrices = [];

        for (const cartItem of cartItems) {
            console.log('Processing cart item:', cartItem);
            for (const item of cartItem.items) {
                console.log('Processing product item:', item);
                const productResult = await client.query('SELECT * FROM products WHERE productid = $1', [item.product_id]);
                const product = productResult.rows[0];
                console.log('Product details:', product);

                if (!product || product.stockquantity < item.quantity) {
                    console.log('Product out of stock or does not exist:', product);
                    client.release();
                    return res.status(400).json({ message: 'Some items are out of stock' });
                }

                const itemTotal = item.quantity * product.price;
                totalAmount += itemTotal;

                cartItemsWithPrices.push({
                    ...item,
                    price: product.price,
                });
            }
        }

        console.log('Total amount calculated:', totalAmount);

        // Create payment intent with Stripe running on port 4243
        try {
            const paymentIntentResponse = await axios.post('http://localhost:4243/create-payment-intent', {
                amount: totalAmount * 100, // Amount in cents
                currency: 'mur',
                payment_method: paymentMethodId,
            });

            const paymentIntent = paymentIntentResponse.data;

            if (paymentIntent.status !== 'succeeded') {
                console.log('Payment failed:', paymentIntent);
                return res.status(400).json({ message: 'Payment failed', details: paymentIntent });
            }

            console.log('Payment successful:', paymentIntent);
        } catch (error) {
            console.error('Error creating payment intent:', error.response ? error.response.data : error.message);
            return res.status(400).json({ message: 'Payment intent creation failed', error: error.response ? error.response.data : error.message });
        }

        // Create order
        const orderResult = await client.query(
            'INSERT INTO orders (userid, totalprice, status, action) VALUES ($1, $2, $3, $4) RETURNING orderid',
            [userId, totalAmount, 'Pending', action]
        );

        const orderId = orderResult.rows[0].orderid;
        console.log('Order created with ID:', orderId);

        // Insert order items
        for (const item of cartItemsWithPrices) {
            await client.query(
                'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)',
                [orderId, item.product_id, item.quantity, item.price]
            );

            // Update product stock
            await client.query(
                'UPDATE products SET stockquantity = stockquantity - $1 WHERE productid = $2',
                [item.quantity, item.product_id]
            );
        }

        console.log('Order items inserted and stock updated');

        // Clear cart
        await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);

        client.release();
        res.status(200).json({ message: 'Order placed successfully', orderId });
    } catch (error) {
        if (client) client.release();
        console.error('Error completing order:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});


app.put('/api/users/:userid', async (req, res) => {
    const { userid } = req.params;
    const { email, fullname, address, mobilenumber, nic } = req.body;
    try {
        const client = await pool.connect();
        const updatedUserDetails = await client.query(
            'UPDATE userdetails SET email = $1, fullname = $2, address = $3, mobilenumber = $4, nic = $5 WHERE userid = $6 RETURNING *',
            [email, fullname, address, mobilenumber, nic, userid]
        );
        client.release();
        res.json(updatedUserDetails.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.delete('/api/users/:userid', async (req, res) => {
    const { userid } = req.params;
    try {
        const client = await pool.connect();
        await client.query('DELETE FROM userdetails WHERE userid = $1', [userid]);
        await client.query('DELETE FROM users WHERE userid = $1', [userid]);
        client.release();
        res.json({ message: 'User deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:userid/password', async (req, res) => {
    const { userid } = req.params;
    const { password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const client = await pool.connect();
        await client.query('UPDATE users SET password = $1 WHERE userid = $2', [hashedPassword, userid]);
        client.release();
        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Orders endpoints
app.get('/api/orders', async (req, res, next) => {
    try {
        const result = await pool.query('SELECT * FROM orders');
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// OrderDetails endpoints
app.get('/api/orderdetails', async (req, res, next) => {
    try {
        const result = await pool.query('SELECT * FROM orderdetails');
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

app.post('/complete-order', async (req, res) => {
    const { userId } = req.body;

    try {
        const client = await pool.connect();

        // Get cart items for the user
        const cartItemsResult = await client.query('SELECT * FROM cart_items WHERE user_id = $1', [userId]);
        if (cartItemsResult.rows.length === 0) {
            client.release();
            return res.status(400).json({ message: 'No items in cart' });
        }

        const cartItems = cartItemsResult.rows;

        // Calculate the total amount
        let totalAmount = 0;
        for (const item of cartItems) {
            const product = await client.query('SELECT * FROM products WHERE productid = $1', [item.product_id]);
            totalAmount += item.quantity * product.rows[0].price;
        }

        // Create order
        const orderResult = await client.query(
            'INSERT INTO orders (userid, totalprice, status) VALUES ($1, $2, $3) RETURNING orderid',
            [userId, totalAmount, 'Pending']
        );
        const orderId = orderResult.rows[0].orderid;

        // Insert order items
        for (const item of cartItems) {
            const product = await client.query('SELECT * FROM products WHERE productid = $1', [item.product_id]);
            await client.query(
                'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)',
                [orderId, item.product_id, item.quantity, product.rows[0].price]
            );

            // Decrease product stock
            await client.query(
                'UPDATE products SET stockquantity = stockquantity - $1 WHERE productid = $2',
                [item.quantity, item.product_id]
            );
        }

        // Clear cart
        await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);

        client.release();
        res.status(200).json({ message: 'Order placed successfully', orderId });
    } catch (error) {
        console.error('Error completing order:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Graceful shutdown
const shutdown = () => {
    pool.end(() => {
        console.log('Closed database connection pool.');
        process.exit(0);
    });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Server startup
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
