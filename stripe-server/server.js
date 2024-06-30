const express = require('express');
const stripe = require('stripe')('sk_test_51PWIxYRx1RunhJ8tTjTfzWO7YIDD0CbsHiNot0hA8UsNIGjoO5F290VFsN3GmM7QxfLVCiYirHjWngNNvM6qW0Xr00rzpUVN5C'); // Replace with your Stripe secret key
const cors = require('cors');

const app = express();

app.use(express.static('.'));
app.use(express.json());
app.use(cors());

app.post('/create-payment-intent', async (req, res) => {
    try {
        const { amount } = req.body; // Expecting amount from the client
        const paymentIntent = await stripe.paymentIntents.create({
            amount, // Amount in cents
            currency: 'mur',
            automatic_payment_methods: { enabled: true }
        });

        res.send({
            client_secret: paymentIntent.client_secret,
        });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.listen(4243, () => console.log('Node server listening on port 4242!'));
