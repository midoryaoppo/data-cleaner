'use strict';

const express = require('express');
const { uploader } = require('../middleware/upload');
const dataController = require('../controllers/dataController');
const billingController = require('../controllers/billingController');
const healthController = require('../controllers/healthController');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.get('/health', healthController.health);
router.get('/sample', dataController.sample);
router.post('/upload', uploader.single('file'), dataController.upload);
router.post('/clean', dataController.clean);
router.get('/download/:id', dataController.download);
router.delete('/files/:id', dataController.remove);

router.get('/billing/status', billingController.status);
router.post('/billing/checkout', asyncHandler(billingController.checkout));
router.get('/billing/success', asyncHandler(billingController.success));

module.exports = router;
