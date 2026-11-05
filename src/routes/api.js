'use strict';

const express = require('express');
const { uploader } = require('../middleware/upload');
const dataController = require('../controllers/dataController');
const billingController = require('../controllers/billingController');
const healthController = require('../controllers/healthController');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

router.get('/health', asyncHandler(healthController.health));
router.get('/sample', dataController.sample);
router.post('/upload', uploader.single('file'), asyncHandler(dataController.upload));
router.post('/clean', asyncHandler(dataController.clean));
router.post('/clean/bulk', asyncHandler(dataController.bulkClean));
router.get('/download/:id', asyncHandler(dataController.download));
router.delete('/files/:id', asyncHandler(dataController.remove));

router.get('/billing/status', asyncHandler(billingController.status));
router.post('/billing/checkout', asyncHandler(billingController.checkout));
router.get('/billing/success', asyncHandler(billingController.success));

module.exports = router;
