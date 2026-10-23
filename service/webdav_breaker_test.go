package service

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestWebDAVProviderBreakerFourthRequestDoesNotConnect(t *testing.T) {
	reserved, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := reserved.Addr().String()
	reserved.Close()

	provider := model.StorageProvider{
		ID:                  "breaker-observation",
		Type:                model.StorageProviderTypeWebDAV,
		Endpoint:            fmt.Sprintf("http://%s", address),
		Username:            "user",
		Password:            "password",
		AllowPrivateNetwork: true,
	}
	for attempt := 1; attempt <= 3; attempt++ {
		client, err := newWebDAVClient(provider)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.ReadDir("probe"); err == nil {
			t.Fatalf("attempt %d unexpectedly connected without a server", attempt)
		}
	}

	var hits atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusNotFound)
	}))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	server.Listener = listener
	server.Start()
	defer server.Close()

	client, err := newWebDAVClient(provider)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.ReadDir("probe"); err == nil {
		t.Fatal("fourth request should be rejected while the provider is cooling down")
	}
	if got := hits.Load(); got != 0 {
		t.Fatalf("fourth request opened %d connection(s), want 0", got)
	}
}

func TestWebDAVProviderBreakerFourthRequestSkipsDial(t *testing.T) {
	clock := &webDAVTestClock{now: time.Unix(50, 0)}
	breaker := newWebDAVProviderBreaker(clock.Now)
	provider := webDAVBreakerTestProvider("dial-count", "https://dav.example/dav")
	var dials atomic.Int32
	base := webDAVTestRoundTripper(func(*http.Request) (*http.Response, error) {
		dials.Add(1)
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
	})
	transport := newWebDAVArmoredTransport(provider, base, breaker)
	for attempt := 1; attempt <= 3; attempt++ {
		if _, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint)); err == nil {
			t.Fatalf("attempt %d unexpectedly connected", attempt)
		}
	}
	if got := dials.Load(); got != 3 {
		t.Fatalf("dial attempts before circuit opened = %d, want 3", got)
	}
	if _, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint)); !errors.Is(err, errWebDAVProviderCircuitOpen) {
		t.Fatalf("fourth request returned %v, want circuit open", err)
	}
	if got := dials.Load(); got != 3 {
		t.Fatalf("fourth request dialed %d time(s), want 0", got-3)
	}
	clock.Advance(webDAVProviderCooldown)
	if _, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint)); err == nil {
		t.Fatal("half-open probe unexpectedly connected")
	}
	if got := dials.Load(); got != 4 {
		t.Fatalf("half-open probe dial attempts = %d, want 4 total", got)
	}
	if _, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint)); !errors.Is(err, errWebDAVProviderCircuitOpen) {
		t.Fatalf("failed probe did not reopen circuit: %v", err)
	}
	if got := dials.Load(); got != 4 {
		t.Fatalf("request after failed probe dialed %d time(s), want 0", got-4)
	}
}

func TestWebDAVProviderBreakerCooldownAndHalfOpen(t *testing.T) {
	clock := &webDAVTestClock{now: time.Unix(100, 0)}
	breaker := newWebDAVProviderBreaker(clock.Now)
	provider := webDAVBreakerTestProvider("dav", "https://dav.example/dav")
	var requests atomic.Int32
	base := webDAVTestRoundTripper(func(*http.Request) (*http.Response, error) {
		requests.Add(1)
		return webDAVTestResponse(http.StatusOK), nil
	})
	transport := newWebDAVArmoredTransport(provider, base, breaker)

	for attempt := 1; attempt <= 3; attempt++ {
		response, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint))
		if err != nil {
			t.Fatalf("business success %d triggered breaker: %v", attempt, err)
		}
		response.Body.Close()
	}
	key := providerBreakerKey(provider)
	for attempt := 1; attempt <= 3; attempt++ {
		webDAVTestRecordFailure(t, breaker, key, provider)
	}
	if _, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint)); !errors.Is(err, errWebDAVProviderCircuitOpen) {
		t.Fatalf("open circuit returned %v", err)
	}
	clock.Advance(webDAVProviderCooldown - time.Nanosecond)
	if _, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint)); !errors.Is(err, errWebDAVProviderCircuitOpen) {
		t.Fatalf("request before cooldown returned %v", err)
	}
	clock.Advance(time.Nanosecond)
	response, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint))
	if err != nil {
		t.Fatalf("half-open probe failed: %v", err)
	}
	response.Body.Close()
	if requests.Load() != 4 {
		t.Fatalf("requests = %d, want three successes plus one probe", requests.Load())
	}
	response, err = transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint))
	if err != nil {
		t.Fatalf("successful probe didn't close circuit: %v", err)
	}
	response.Body.Close()
}

func TestWebDAVProviderBreakerSuccessfulProbeClearsFailures(t *testing.T) {
	clock := &webDAVTestClock{now: time.Unix(200, 0)}
	breaker := newWebDAVProviderBreaker(clock.Now)
	provider := webDAVBreakerTestProvider("dav", "https://dav.example/dav")
	transport := newWebDAVArmoredTransport(provider, webDAVTestRoundTripper(func(*http.Request) (*http.Response, error) {
		return webDAVTestResponse(http.StatusNotFound), nil
	}), breaker)
	key := providerBreakerKey(provider)
	for attempt := 1; attempt <= 3; attempt++ {
		webDAVTestRecordFailure(t, breaker, key, provider)
	}
	clock.Advance(webDAVProviderCooldown)
	response, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint))
	if err != nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("half-open business response = %+v, %v", response, err)
	}
	response.Body.Close()
	if got := breaker.next(key, provider.Name, provider.Endpoint); !got.acquire {
		t.Fatalf("successful probe didn't reset circuit: %+v", got)
	}
}

func TestWebDAVProviderBreakerBusinessStatusesDoNotCount(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusInternalServerError} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			clock := &webDAVTestClock{now: time.Unix(300, 0)}
			breaker := newWebDAVProviderBreaker(clock.Now)
			provider := webDAVBreakerTestProvider("dav", "https://dav.example/dav")
			var requests atomic.Int32
			transport := newWebDAVArmoredTransport(provider, webDAVTestRoundTripper(func(*http.Request) (*http.Response, error) {
				requests.Add(1)
				return webDAVTestResponse(status), nil
			}), breaker)
			for attempt := 1; attempt <= 4; attempt++ {
				response, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint))
				if err != nil || response.StatusCode != status {
					t.Fatalf("business response %d = %+v, %v", attempt, response, err)
				}
				response.Body.Close()
			}
			if requests.Load() != 4 {
				t.Fatalf("requests = %d, want all business statuses forwarded", requests.Load())
			}
			if got := breaker.next(providerBreakerKey(provider), provider.Name, provider.Endpoint); !got.acquire {
				t.Fatalf("business status opened circuit: %+v", got)
			}
		})
	}
}

func TestWebDAVProviderBreakerBodyReadFailure(t *testing.T) {
	provider := webDAVBreakerTestProvider("body-read", "https://dav.example/dav")
	breaker := newWebDAVProviderBreaker(time.Now)
	transport := newWebDAVArmoredTransport(provider, webDAVTestRoundTripper(func(*http.Request) (*http.Response, error) {
		return webDAVTestResponse(http.StatusOK), nil
	}), breaker)
	transport.base = &webDAVBrokenBodyTransport{transport: transport}
	for attempt := 1; attempt <= 3; attempt++ {
		response, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
	}
	if got := breaker.next(providerBreakerKey(provider), provider.Name, provider.Endpoint); !got.shortCircuited {
		t.Fatalf("body read failures weren't counted: %+v", got)
	}
}

func TestWebDAVProviderBreakerHalfOpenBodyReadFailureReopensCircuit(t *testing.T) {
	clock := &webDAVTestClock{now: time.Unix(450, 0)}
	breaker := newWebDAVProviderBreaker(clock.Now)
	provider := webDAVBreakerTestProvider("half-open-body", "https://dav.example/dav")
	key := providerBreakerKey(provider)
	for attempt := 1; attempt <= 3; attempt++ {
		webDAVTestRecordFailure(t, breaker, key, provider)
	}
	clock.Advance(webDAVProviderCooldown)
	transport := newWebDAVArmoredTransport(provider, &webDAVBrokenBodyTransport{}, breaker)
	response, err := transport.RoundTrip(webDAVProbeRequest(t, provider.Endpoint))
	if err != nil {
		t.Fatalf("half-open request failed before body read: %v", err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}

	breaker.mu.Lock()
	probing := breaker.state[key].probing
	openUntil := breaker.state[key].openUntil
	breaker.mu.Unlock()
	if probing {
		t.Fatal("half-open body failure left breaker stuck in probing state")
	}
	if !openUntil.After(clock.Now()) {
		t.Fatalf("half-open body failure did not reopen circuit: openUntil=%s now=%s", openUntil, clock.Now())
	}
	if got := breaker.next(key, provider.Name, provider.Endpoint); !got.shortCircuited {
		t.Fatalf("request after failed half-open probe was not short-circuited: %+v", got)
	}
}

func TestWebDAVProviderBreakerKeysAndSingleLog(t *testing.T) {
	clock := &webDAVTestClock{now: time.Unix(400, 0)}
	breaker := newWebDAVProviderBreaker(clock.Now)
	providers := []model.StorageProvider{
		webDAVBreakerTestProvider("same-id", "https://one.example/dav"),
		webDAVBreakerTestProvider("same-id", "https://two.example/dav"),
		webDAVBreakerTestProvider("", "https://three.example/dav"),
	}
	for _, provider := range providers {
		key := providerBreakerKey(provider)
		for attempt := 1; attempt <= 3; attempt++ {
			webDAVTestRecordFailure(t, breaker, key, provider)
		}
		if got := breaker.next(key, provider.Name, provider.Endpoint); !got.shortCircuited {
			t.Fatalf("provider %q wasn't open: %+v", provider.ID, got)
		}
	}
	if got := breaker.next(providerBreakerKey(providers[0]), providers[0].Name, providers[0].Endpoint); !got.shortCircuited {
		t.Fatalf("same ID and endpoint wasn't open: %+v", got)
	}

	var logs strings.Builder
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })
	target := webDAVBreakerTestProvider("log-id", "https://log.example/dav")
	for attempt := 1; attempt <= 3; attempt++ {
		webDAVTestRecordFailure(t, breaker, providerBreakerKey(target), target)
	}
	for attempt := 1; attempt <= 20; attempt++ {
		breaker.next(providerBreakerKey(target), target.Name, target.Endpoint)
	}
	output := logs.String()
	if got := strings.Count(output, "webdav provider circuit open"); got != 1 {
		t.Fatalf("circuit open logged %d times, want one aggregate log: %s", got, output)
	}
	if !strings.Contains(output, "provider=log-id") || !strings.Contains(output, "remaining=") {
		t.Fatalf("log lacks provider or remaining time: %s", output)
	}
}

func TestWebDAVProviderBreakerConcurrent(t *testing.T) {
	clock := &webDAVTestClock{now: time.Unix(500, 0)}
	breaker := newWebDAVProviderBreaker(clock.Now)
	provider := webDAVBreakerTestProvider("concurrent", "https://dav.example/dav")
	key := providerBreakerKey(provider)
	var accepted atomic.Int32
	var shortCircuits atomic.Int32
	var wait sync.WaitGroup
	for index := 0; index < 64; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for attempt := 0; attempt < 32; attempt++ {
				decision := breaker.next(key, provider.Name, provider.Endpoint)
				if !decision.acquire {
					if decision.shortCircuited {
						shortCircuits.Add(1)
					}
					continue
				}
				accepted.Add(1)
				breaker.recordAttempt(key, decision, true)
			}
		}()
	}
	wait.Wait()
	if accepted.Load() != 3 {
		t.Fatalf("accepted concurrent attempts = %d, want 3", accepted.Load())
	}
	if shortCircuits.Load() != int32(64*32-3) {
		t.Fatalf("short-circuits = %d, want %d", shortCircuits.Load(), 64*32-3)
	}
	if got := breaker.next(key, provider.Name, provider.Endpoint); !got.shortCircuited {
		t.Fatalf("circuit not open after concurrent failures: %+v", got)
	}
}

func TestWebDAVProviderBreakerAuthRedoReleasesWithoutSettling(t *testing.T) {
	var requests atomic.Int32
	var pendingBeforeRetry atomic.Bool
	var key string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch requests.Add(1) {
		case 1:
			response.Header().Set("WWW-Authenticate", `Basic realm="test"`)
			response.WriteHeader(http.StatusUnauthorized)
		default:
			if authorization := request.Header.Get("Authorization"); authorization != "" {
				webDAVProviderBreakers.mu.Lock()
				state := webDAVProviderBreakers.state[key]
				_, pendingBeforeRetryValue := state.inFlight[state.probeID]
				webDAVProviderBreakers.mu.Unlock()
				pendingBeforeRetry.Store(pendingBeforeRetryValue)
				response.WriteHeader(http.StatusOK)
				return
			}
			response.Header().Set("WWW-Authenticate", `Basic realm="test"`)
			response.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer server.Close()
	provider := webDAVBreakerTestProvider("auth-redo", server.URL)
	key = providerBreakerKey(provider)
	for attempt := 1; attempt <= 2; attempt++ {
		webDAVTestRecordFailure(t, webDAVProviderBreakers, key, provider)
	}

	provider.Username = "user"
	provider.Password = "password"
	provider.AllowPrivateNetwork = true
	client, err := newWebDAVClient(provider)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Connect(); err != nil {
		t.Fatalf("auth retry failed: %v", err)
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("auth retry requests = %d, want 2", got)
	}
	webDAVProviderBreakers.mu.Lock()
	failures := webDAVProviderBreakers.state[key].failures
	openUntil := webDAVProviderBreakers.state[key].openUntil
	webDAVProviderBreakers.mu.Unlock()
	if pendingBeforeRetry.Load() {
		t.Fatal("auth redo left the discarded request in the failure budget")
	}
	if failures != 0 {
		t.Fatalf("successful retry failures = %d, want 0", failures)
	}
	if !openUntil.IsZero() {
		t.Fatalf("auth redo unexpectedly opened circuit until %s", openUntil)
	}
}

func TestWebDAVDiscardCloseReleasesWithoutSettling(t *testing.T) {
	clock := &webDAVTestClock{now: time.Unix(650, 0)}
	breaker := newWebDAVProviderBreaker(clock.Now)
	provider := webDAVBreakerTestProvider("discard", "https://dav.example/dav")
	key := providerBreakerKey(provider)
	for attempt := 1; attempt <= 2; attempt++ {
		webDAVTestRecordFailure(t, breaker, key, provider)
	}
	attempt := breaker.next(key, provider.Name, provider.Endpoint)
	if !attempt.acquire {
		t.Fatalf("discard attempt was not acquired: %+v", attempt)
	}
	body := &webDAVBody{
		ReadCloser: io.NopCloser(strings.NewReader("")),
		transport:  newWebDAVArmoredTransport(provider, nil, breaker),
		attempt:    attempt,
	}
	body.discardResponse()
	if err := body.Close(); err != nil {
		t.Fatal(err)
	}
	next := breaker.next(key, provider.Name, provider.Endpoint)
	if !next.acquire {
		t.Fatalf("discard close changed breaker progress: %+v", next)
	}
	breaker.recordAttempt(key, attempt, true)
	if nextAttempt := breaker.next(key, provider.Name, provider.Endpoint); !nextAttempt.shortCircuited {
		t.Fatalf("released slot wasn't reusable: %+v", nextAttempt)
	}
	breaker.recordAttempt(key, next, false)
	if got := breaker.state[key].failures; got != 0 {
		t.Fatalf("settled result after discard = %d failures, want 0", got)
	}
}

func TestWebDAVProviderBreakerIgnoresInFlightResultsAfterThreshold(t *testing.T) {
	clock := &webDAVTestClock{now: time.Unix(600, 0)}
	breaker := newWebDAVProviderBreaker(clock.Now)
	provider := webDAVBreakerTestProvider("late-results", "https://dav.example/dav")
	key := providerBreakerKey(provider)
	attempts := make([]webDAVAttempt, 3)
	for index := range attempts {
		attempts[index] = breaker.next(key, provider.Name, provider.Endpoint)
		if !attempts[index].acquire {
			t.Fatalf("attempt %d was not acquired: %+v", index+1, attempts[index])
		}
	}
	if got := breaker.next(key, provider.Name, provider.Endpoint); !got.shortCircuited {
		t.Fatalf("fourth in-flight attempt bypassed failure budget: %+v", got)
	}
	for _, attempt := range attempts {
		breaker.recordAttempt(key, attempt, true)
	}
	if got := breaker.next(key, provider.Name, provider.Endpoint); !got.shortCircuited {
		t.Fatalf("late results reopened or extended circuit: %+v", got)
	}

	openedUntil := breaker.state[key].openUntil
	clock.Advance(time.Second)
	breaker.recordAttempt(key, attempts[0], false)
	if got := breaker.state[key].openUntil; !got.Equal(openedUntil) {
		t.Fatalf("late success changed cooldown from %s to %s", openedUntil, got)
	}
	clock.Advance(webDAVProviderCooldown)
	if got := breaker.next(key, provider.Name, provider.Endpoint); !got.halfOpen {
		t.Fatalf("circuit did not transition to a single half-open probe: %+v", got)
	}
}

func webDAVTestRecordFailure(t *testing.T, breaker *webDAVProviderBreaker, key string, provider model.StorageProvider) {
	t.Helper()
	attempt := breaker.next(key, provider.Name, provider.Endpoint)
	if !attempt.acquire {
		t.Fatalf("failed to acquire request while recording a failure: %+v", attempt)
	}
	breaker.recordAttempt(key, attempt, true)
}

type webDAVTestClock struct {
	mutex sync.Mutex
	now   time.Time
}

func (clock *webDAVTestClock) Now() time.Time {
	clock.mutex.Lock()
	defer clock.mutex.Unlock()
	return clock.now
}

func (clock *webDAVTestClock) Advance(duration time.Duration) {
	clock.mutex.Lock()
	clock.now = clock.now.Add(duration)
	clock.mutex.Unlock()
}

func webDAVBreakerTestProvider(id, endpoint string) model.StorageProvider {
	return model.StorageProvider{ID: id, Name: id, Type: model.StorageProviderTypeWebDAV, Endpoint: endpoint}
}

func webDAVProbeRequest(t *testing.T, endpoint string) *http.Request {
	request, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func webDAVTestResponse(status int) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader("")),
	}
}

type webDAVTestRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip webDAVTestRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

type webDAVBrokenBody struct{}

type webDAVBrokenBodyTransport struct {
	transport *webDAVArmoredTransport
}

func (transport *webDAVBrokenBodyTransport) RoundTrip(*http.Request) (*http.Response, error) {
	response := webDAVTestResponse(http.StatusOK)
	response.Body = &webDAVBrokenBody{}
	return response, nil
}

func (webDAVBrokenBody) Read([]byte) (int, error) {
	return 0, io.ErrUnexpectedEOF
}

func (webDAVBrokenBody) Close() error {
	return nil
}
