@api
Feature: Wikipedia API evidence

  @p1
  Scenario: Read Wikipedia site information
    Given the English Wikipedia API is selected
    When I request the Wikipedia site information
    Then the API status should be 200
    And the site name should be "Wikipedia"

  @intentional-failure
  Scenario: Demonstrate a failed API assertion
    Given the English Wikipedia API is selected
    When I request the Wikipedia site information
    # Intentionally wrong: a successful API response returns 200.
    Then the API status should be 418
    And the site name should be "Wikipedia"
