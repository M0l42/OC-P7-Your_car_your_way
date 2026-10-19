package com.ycyw.chat.rest;

import com.ycyw.chat.conversation.ChatError;
import com.ycyw.chat.conversation.ChatException;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/** Maps rejections to {@code ApiError} with the contract's HTTP statuses (protocol.md §4). */
@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(ChatException.class)
    ResponseEntity<ApiError> rejected(ChatException e) {
        return ResponseEntity.status(e.code().httpStatus()).body(new ApiError(e.code(), e.reason()));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class,
            MissingServletRequestParameterException.class})
    ResponseEntity<ApiError> malformed(Exception e) {
        return ResponseEntity.badRequest().body(new ApiError(ChatError.INVALID_REQUEST, "malformed request"));
    }
}
