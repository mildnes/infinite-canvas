package service

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

const webDAVProviderCooldown = 60 * time.Second

const webDAVProviderFailureThreshold = 3

var (
	webDAVProviderBreakers       = newWebDAVProviderBreaker(time.Now)
	errWebDAVProviderCircuitOpen = errors.New("WebDAV provider circuit open")
)

type webDAVAttempt struct {
	acquire        bool
	halfOpen       bool
	shortCircuited bool
	remaining      time.Duration
	inFlight       uint64
	generation     uint64
}

type webDAVProviderState struct {
	generation uint64
	failures   int
	openUntil  time.Time
	probing    bool
	probeID    uint64
	inFlight   map[uint64]struct{}
	notified   bool
}

type webDAVProviderBreaker struct {
	mu     sync.Mutex
	now    func() time.Time
	logger *log.Logger
	settle webDAVSettleFunc
	state  map[string]*webDAVProviderState
	nextID uint64
}

type webDAVSettleFunc func(key string, attempt webDAVAttempt, connectionFailure bool)

func newWebDAVProviderBreaker(now func() time.Time) *webDAVProviderBreaker {
	return newWebDAVProviderBreakerWithLogger(now, log.Default())
}

func newWebDAVProviderBreakerWithLogger(now func() time.Time, logger *log.Logger) *webDAVProviderBreaker {
	breaker := &webDAVProviderBreaker{now: now, logger: logger, state: make(map[string]*webDAVProviderState)}
	breaker.settle = breaker.recordAttempt
	return breaker
}

func providerBreakerKey(provider model.StorageProvider) string {
	return strings.TrimSpace(provider.ID) + "\x00" + strings.TrimSpace(provider.Endpoint)
}

func (breaker *webDAVProviderBreaker) next(key, provider, endpoint string) webDAVAttempt {
	breaker.mu.Lock()
	defer breaker.mu.Unlock()
	current := breaker.now()
	state := breaker.state[key]
	if state == nil {
		state = &webDAVProviderState{inFlight: make(map[uint64]struct{})}
		breaker.state[key] = state
	}
	if !state.openUntil.IsZero() {
		if current.Before(state.openUntil) {
			remaining := state.openUntil.Sub(current)
			if !state.notified {
				breaker.logger.Printf("webdav provider circuit open provider=%s endpoint=%s remaining=%s", provider, endpoint, remaining.Round(time.Millisecond))
				state.notified = true
			}
			return webDAVAttempt{shortCircuited: true, remaining: remaining}
		}
		if state.probing {
			return webDAVAttempt{shortCircuited: true}
		}
		state.probing = true
		breaker.nextID++
		state.probeID = breaker.nextID
		return webDAVAttempt{acquire: true, halfOpen: true, inFlight: breaker.nextID, generation: state.generation}
	}
	if state.failures+len(state.inFlight) >= webDAVProviderFailureThreshold {
		return webDAVAttempt{shortCircuited: true}
	}
	breaker.nextID++
	state.inFlight[breaker.nextID] = struct{}{}
	return webDAVAttempt{acquire: true, inFlight: breaker.nextID, generation: state.generation}
}

func (breaker *webDAVProviderBreaker) recordAttempt(key string, attempt webDAVAttempt, connectionFailure bool) {
	breaker.mu.Lock()
	defer breaker.mu.Unlock()
	state := breaker.state[key]
	if state == nil || attempt.inFlight == 0 || attempt.generation != state.generation {
		return
	}
	if attempt.halfOpen {
		if !state.probing || attempt.inFlight != state.probeID {
			return
		}
		state.probing = false
		state.probeID = 0
		if connectionFailure {
			breaker.openLocked(state)
			return
		}
		state.failures = 0
		state.openUntil = time.Time{}
		state.notified = false
		state.inFlight = make(map[uint64]struct{})
		state.generation++
		return
	}
	if _, found := state.inFlight[attempt.inFlight]; !found {
		return
	}
	delete(state.inFlight, attempt.inFlight)
	if connectionFailure {
		state.failures++
		if state.failures >= webDAVProviderFailureThreshold {
			breaker.openLocked(state)
		}
		return
	}
	state.failures = 0
}

func (breaker *webDAVProviderBreaker) release(key string, attempt webDAVAttempt) {
	breaker.mu.Lock()
	defer breaker.mu.Unlock()
	state := breaker.state[key]
	if state == nil || attempt.inFlight == 0 || attempt.generation != state.generation {
		return
	}
	if attempt.halfOpen {
		if state.probing && attempt.inFlight == state.probeID {
			state.probing = false
			state.probeID = 0
		}
		return
	}
	delete(state.inFlight, attempt.inFlight)
}

func (breaker *webDAVProviderBreaker) recordBodyFailure(key string, attempt webDAVAttempt) {
	breaker.mu.Lock()
	defer breaker.mu.Unlock()
	state := breaker.state[key]
	if state == nil || attempt.inFlight == 0 || attempt.generation != state.generation {
		return
	}
	if attempt.halfOpen {
		if !state.probing || attempt.inFlight != state.probeID {
			return
		}
		breaker.openLocked(state)
		return
	}
	if !state.openUntil.IsZero() {
		return
	}
	if _, found := state.inFlight[attempt.inFlight]; !found {
		return
	}
	delete(state.inFlight, attempt.inFlight)
	state.failures++
	if state.failures >= webDAVProviderFailureThreshold {
		breaker.openLocked(state)
	}
}

func (breaker *webDAVProviderBreaker) openLocked(state *webDAVProviderState) {
	state.failures = webDAVProviderFailureThreshold
	state.openUntil = breaker.now().Add(webDAVProviderCooldown)
	state.probing = false
	state.probeID = 0
	state.notified = false
	state.generation++
}

type webDAVArmoredTransport struct {
	provider model.StorageProvider
	base     http.RoundTripper
	breaker  *webDAVProviderBreaker
}

func newWebDAVArmoredTransport(provider model.StorageProvider, base http.RoundTripper, breaker *webDAVProviderBreaker) *webDAVArmoredTransport {
	return &webDAVArmoredTransport{provider: provider, base: base, breaker: breaker}
}

func (transport *webDAVArmoredTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	attempt := transport.breaker.next(providerBreakerKey(transport.provider), transport.provider.ID, transport.provider.Endpoint)
	if !attempt.acquire {
		return nil, errWebDAVProviderCircuitOpen
	}
	response, err := transport.base.RoundTrip(request)
	if err != nil {
		transport.breaker.settle(providerBreakerKey(transport.provider), attempt, webDAVConnectionFailure(err))
		return response, err
	}
	body := &webDAVBody{
		ReadCloser:    response.Body,
		transport:     transport,
		attempt:       attempt,
		statusCode:    response.StatusCode,
		authChallenge: response.StatusCode == http.StatusUnauthorized && response.Header.Get("WWW-Authenticate") != "",
	}
	response.Body = body
	return response, nil
}

type webDAVBody struct {
	io.ReadCloser
	transport     *webDAVArmoredTransport
	attempt       webDAVAttempt
	statusCode    int
	authChallenge bool
	mutex         sync.Mutex
	once          sync.Once
	discard       bool
	failure       bool
}

func (body *webDAVBody) Read(buffer []byte) (int, error) {
	count, err := body.ReadCloser.Read(buffer)
	if err != nil && err != io.EOF {
		// Response headers may be available before the server starts streaming.
		// EOF on protocol-framed bodies commonly indicates a truncated response.
		if isWebDAVBodyReadFailure(err) {
			body.mutex.Lock()
			body.failure = true
			body.mutex.Unlock()
		}
	}
	return count, err
}

func (body *webDAVBody) Close() error {
	closeErr := body.ReadCloser.Close()
	body.mutex.Lock()
	failure := body.failure
	body.mutex.Unlock()
	failure = failure || isWebDAVBodyReadFailure(closeErr)
	discard := body.isDiscard() || (!failure && body.authChallenge)
	body.record(failure, discard)
	return closeErr
}

func (body *webDAVBody) discardResponse() {
	body.mutex.Lock()
	body.discard = true
	body.mutex.Unlock()
}

func (body *webDAVBody) isDiscard() bool {
	body.mutex.Lock()
	defer body.mutex.Unlock()
	return body.discard
}

func (body *webDAVBody) record(failure, discard bool) {
	body.once.Do(func() {
		if failure {
			body.transport.breaker.recordBodyFailure(providerBreakerKey(body.transport.provider), body.attempt)
			return
		}
		if discard {
			body.transport.breaker.release(providerBreakerKey(body.transport.provider), body.attempt)
			return
		}
		body.transport.breaker.settle(providerBreakerKey(body.transport.provider), body.attempt, false)
	})
}

func webDAVConnectionFailure(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	for _, target := range []error{
		syscall.ECONNREFUSED, syscall.ECONNRESET, syscall.EHOSTUNREACH, syscall.ENETUNREACH, context.DeadlineExceeded,
	} {
		if errors.Is(err, target) {
			return true
		}
	}
	return false
}

func isWebDAVBodyReadFailure(err error) bool {
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		// A truncated chunked response surfaces as EOF, not io.ErrUnexpectedEOF.
		return errors.Is(urlErr.Err, io.EOF)
	}
	var netErr net.Error
	return errors.As(err, &netErr)
}
