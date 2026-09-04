/**
 * Standard API Response Format -- 1:1 aus fahrstuhl/services/apiResponse.js uebernommen.
 */

class APIResponse {
    static success(data, message = 'Success', code = 'SUCCESS') {
        return { success: true, code, message, data, timestamp: new Date().toISOString() };
    }

    static error(message = 'An error occurred', code = 'ERROR', statusCode = 500) {
        return { success: false, code, message, statusCode, timestamp: new Date().toISOString() };
    }

    static validationError(message = 'Validation failed', errors = {}) {
        return { success: false, code: 'VALIDATION_ERROR', message, errors, statusCode: 400, timestamp: new Date().toISOString() };
    }

    static notFound(message = 'Resource not found') {
        return { success: false, code: 'NOT_FOUND', message, statusCode: 404, timestamp: new Date().toISOString() };
    }

    static unauthorized(message = 'Unauthorized') {
        return { success: false, code: 'UNAUTHORIZED', message, statusCode: 401, timestamp: new Date().toISOString() };
    }

    static forbidden(message = 'Forbidden') {
        return { success: false, code: 'FORBIDDEN', message, statusCode: 403, timestamp: new Date().toISOString() };
    }

    static badRequest(message = 'Bad request') {
        return { success: false, code: 'BAD_REQUEST', message, statusCode: 400, timestamp: new Date().toISOString() };
    }
}

module.exports = APIResponse;
