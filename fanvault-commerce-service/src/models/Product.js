const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      maxlength: [200, 'Name cannot exceed 200 characters'],
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },
    comparePrice: {
      type: Number,
      min: [0, 'Compare price cannot be negative'],
    },
    category: {
      type: String,
      required: true,
      enum: ['clothing', 'accessories', 'shoes', 'ornaments'],
    },
    franchise: {
      type: String,
      required: true,
    },
    franchiseType: {
      type: String,
      enum: ['sports', 'movie', 'show'],
      required: true,
    },
    tags:   [String],
    images: [String],
    sku: {
      type: String,
      unique: true,
      required: true,
    },
    stock: {
      type: Number,
      required: true,
      min: [0, 'Stock cannot be negative'],
      default: 0,
    },
    sizes:  [String],
    colors: [String],
    rating: {
      average: { type: Number, default: 0, min: 0, max: 5 },
      count:   { type: Number, default: 0 },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Full-text search index across name, description, and tags
productSchema.index({ name: 'text', description: 'text', tags: 'text' });
// Compound index for efficient category + franchise filtering
productSchema.index({ category: 1, franchise: 1 });

module.exports = mongoose.model('Product', productSchema);
